use std::io;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use url::Url;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CALLBACK_ADDR: &str = "127.0.0.1:1455";
const SCOPE: &str = "openid profile email offline_access";
const REVOKE_ENDPOINT: &str = "https://auth.openai.com/oauth/revoke";
const REFRESH_MARGIN_MS: u64 = 60_000;
const TOKEN_TIMEOUT: Duration = Duration::from_secs(30);
const OAUTH_ACCEPT_TIMEOUT: Duration = Duration::from_secs(300);
const OAUTH_READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCredential {
    #[serde(rename = "type", default = "credential_type")]
    credential_type: String,
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

struct PkcePair {
    verifier: String,
    challenge: String,
}

struct OAuthCallback {
    code: String,
    state: String,
}

pub fn load_credential(app: &AppHandle) -> Result<Option<CodexCredential>, String> {
    let path = super::credential_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("Некорректный файл учетных данных Codex: {error}"))
}

pub fn save_credential(app: &AppHandle, credential: &CodexCredential) -> Result<(), String> {
    let path = super::credential_path(app)?;
    let text = serde_json::to_string_pretty(credential).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| error.to_string())
}

pub fn delete_credential(app: &AppHandle) -> Result<(), String> {
    let path = super::credential_path(app)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub async fn ensure_fresh_credential(
    app: &AppHandle,
    client: &reqwest::Client,
) -> Result<CodexCredential, String> {
    let mut credential = load_credential(app)?
        .ok_or_else(|| "Codex OAuth не авторизован. Подключи Codex в настройках.".to_string())?;

    if is_near_expiry(&credential) {
        if credential.refresh_token.trim().is_empty() {
            return Err("Токен Codex OAuth истек. Переподключи Codex в настройках.".to_string());
        }
        let tokens = post_token(
            client,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", credential.refresh_token.as_str()),
                ("client_id", CLIENT_ID),
            ],
        )
        .await?;
        apply_tokens(&mut credential, tokens);
        save_credential(app, &credential)?;
    }

    Ok(credential)
}

pub async fn run_oauth(client: &reqwest::Client) -> Result<CodexCredential, String> {
    let pkce = pkce_pair();
    let state = random_url_token(16);
    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|error| {
        format!("Не удалось запустить OAuth callback listener на {CALLBACK_ADDR}: {error}")
    })?;
    let auth_url = authorize_url(&pkce.challenge, &state)?;
    open::that(&auth_url)
        .map_err(|error| format!("Не удалось открыть браузер для Codex OAuth: {error}"))?;

    let callback = wait_for_callback(listener).await?;
    if callback.state != state {
        return Err("OAuth state не совпал".to_string());
    }

    let tokens = post_token(
        client,
        &[
            ("grant_type", "authorization_code"),
            ("code", callback.code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
            ("code_verifier", pkce.verifier.as_str()),
        ],
    )
    .await?;

    let account_id = tokens
        .id_token
        .as_deref()
        .or(Some(tokens.access_token.as_str()))
        .and_then(parse_jwt_claims)
        .and_then(|claims| account_id_from_claims(&claims));

    Ok(CodexCredential {
        credential_type: credential_type(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        expires_at: tokens
            .expires_in
            .map(|seconds| now_millis().saturating_add(seconds.saturating_mul(1000))),
        account_id,
    })
}

pub async fn revoke_credential(
    client: &reqwest::Client,
    credential: &CodexCredential,
) -> Result<(), String> {
    let refresh = credential.refresh_token.trim();
    let access = credential.access_token.trim();
    let (token, token_type_hint, client_id) = if !refresh.is_empty() {
        (refresh, "refresh_token", Some(CLIENT_ID))
    } else if !access.is_empty() {
        (access, "access_token", None)
    } else {
        return Ok(());
    };

    let mut body = serde_json::Map::new();
    body.insert("token".to_string(), Value::String(token.to_string()));
    body.insert(
        "token_type_hint".to_string(),
        Value::String(token_type_hint.to_string()),
    );
    if let Some(client_id) = client_id {
        body.insert(
            "client_id".to_string(),
            Value::String(client_id.to_string()),
        );
    }

    let response = client
        .post(REVOKE_ENDPOINT)
        .timeout(Duration::from_secs(10))
        .json(&Value::Object(body))
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Codex отклонил отзыв токена: {}",
            response.status()
        ))
    }
}

async fn post_token(
    client: &reqwest::Client,
    form: &[(&str, &str)],
) -> Result<TokenResponse, String> {
    let response = client
        .post(format!("{ISSUER}/oauth/token"))
        .timeout(TOKEN_TIMEOUT)
        .form(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Обмен токена Codex OAuth завершился ошибкой со статусом {}",
            status.as_u16()
        ));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("Некорректный ответ Codex token endpoint: {error}"))
}

fn apply_tokens(credential: &mut CodexCredential, tokens: TokenResponse) {
    credential.access_token = tokens.access_token;
    if !tokens.refresh_token.trim().is_empty() {
        credential.refresh_token = tokens.refresh_token;
    }
    if let Some(id_token) = tokens.id_token {
        credential.id_token = Some(id_token);
    }
    credential.expires_at = tokens
        .expires_in
        .map(|seconds| now_millis().saturating_add(seconds.saturating_mul(1000)));
}

async fn wait_for_callback(listener: TcpListener) -> Result<OAuthCallback, String> {
    let accepted = timeout(OAUTH_ACCEPT_TIMEOUT, listener.accept())
        .await
        .map_err(|_| "Истекло время ожидания Codex OAuth callback".to_string())?
        .map_err(|error| error.to_string())?;
    let (mut stream, _) = accepted;

    let mut buffer = vec![0_u8; 8192];
    let bytes_read = timeout(OAUTH_READ_TIMEOUT, stream.read(&mut buffer))
        .await
        .map_err(|_| "Истекло время чтения Codex OAuth callback".to_string())?
        .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);

    let callback = parse_callback_request(&request);
    let body = if callback.is_ok() {
        OAUTH_SUCCESS_BODY
    } else {
        OAUTH_ERROR_BODY
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    callback
}

fn parse_callback_request(request: &str) -> Result<OAuthCallback, String> {
    let first_line = request
        .lines()
        .next()
        .ok_or_else(|| "OAuth callback request пустой".to_string())?;
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if method != "GET" {
        return Err("OAuth callback использовал неожиданный HTTP method".to_string());
    }

    let url = Url::parse(&format!("http://localhost{target}"))
        .map_err(|error| format!("Некорректный OAuth callback URL: {error}"))?;
    let params = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    if let Some(error) = params.get("error") {
        return Err(format!("Codex OAuth отклонил авторизацию: {error}"));
    }
    let code = params
        .get("code")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OAuth callback не содержит code".to_string())?
        .to_string();
    let state = params
        .get("state")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OAuth callback не содержит state".to_string())?
        .to_string();

    Ok(OAuthCallback { code, state })
}

fn authorize_url(code_challenge: &str, state: &str) -> Result<String, String> {
    let mut url =
        Url::parse(&format!("{ISSUER}/oauth/authorize")).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", "quest_keeper_ai");
    Ok(url.to_string())
}

fn pkce_pair() -> PkcePair {
    let verifier = random_url_token(32);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    PkcePair {
        verifier,
        challenge,
    }
}

fn random_url_token(byte_len: usize) -> String {
    let mut bytes = vec![0_u8; byte_len];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn parse_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn account_id_from_claims(claims: &Value) -> Option<String> {
    claims
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|value| value.get("chatgpt_account_id"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
}

fn is_near_expiry(credential: &CodexCredential) -> bool {
    credential
        .expires_at
        .map(|expires_at| expires_at <= now_millis().saturating_add(REFRESH_MARGIN_MS))
        .unwrap_or(false)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn credential_type() -> String {
    "openai_codex_oauth".to_string()
}

const OAUTH_SUCCESS_BODY: &str =
    "<!doctype html><meta charset=utf-8><title>Quest Keeper AI</title>\
<body style=\"font-family:system-ui;background:#0b0f14;color:#eaf1f8\">\
<p>Codex авторизован. Можно закрыть эту вкладку и вернуться в Quest Keeper AI.</p>";

const OAUTH_ERROR_BODY: &str = "<!doctype html><meta charset=utf-8><title>Quest Keeper AI</title>\
<body style=\"font-family:system-ui;background:#0b0f14;color:#eaf1f8\">\
<p>Авторизация Codex не удалась. Вернитесь в Quest Keeper AI и попробуйте снова.</p>";
