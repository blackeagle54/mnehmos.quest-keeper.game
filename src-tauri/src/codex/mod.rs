use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

mod oauth;

const RESPONSES_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_ORIGINATOR: &str = "codex_cli_rs";
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.133.0 (Quest Keeper AI)";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    authenticated: bool,
    account_id: Option<String>,
    expires_at: Option<u64>,
    message: String,
}

impl CodexAuthStatus {
    fn missing() -> Self {
        Self {
            authenticated: false,
            account_id: None,
            expires_at: None,
            message: "Codex OAuth не авторизован".to_string(),
        }
    }

    fn from_credential(credential: &oauth::CodexCredential) -> Self {
        Self {
            authenticated: true,
            account_id: credential.account_id.clone(),
            expires_at: credential.expires_at,
            message: "Codex OAuth авторизован".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatRequest {
    model: String,
    messages: Vec<CodexChatMessage>,
    #[serde(default)]
    tools: Vec<Value>,
}

#[derive(Debug, Deserialize)]
pub struct CodexChatMessage {
    role: String,
    content: String,
    #[serde(default, rename = "toolCalls")]
    tool_calls: Vec<CodexToolCall>,
    #[serde(default, rename = "toolCallId")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexToolCall {
    #[serde(default)]
    id: Option<String>,
    name: String,
    arguments: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChatResponse {
    content: String,
    tool_calls: Vec<CodexToolCall>,
}

#[tauri::command]
pub async fn codex_auth_status(app: AppHandle) -> Result<CodexAuthStatus, String> {
    let credential = oauth::load_credential(&app)?;
    Ok(match credential {
        Some(credential) => CodexAuthStatus::from_credential(&credential),
        None => CodexAuthStatus::missing(),
    })
}

#[tauri::command]
pub async fn codex_authenticate(app: AppHandle) -> Result<CodexAuthStatus, String> {
    let client = http_client()?;
    let credential = oauth::run_oauth(&client).await?;
    oauth::save_credential(&app, &credential)?;
    Ok(CodexAuthStatus::from_credential(&credential))
}

#[tauri::command]
pub async fn codex_logout(app: AppHandle) -> Result<CodexAuthStatus, String> {
    if let Some(credential) = oauth::load_credential(&app)? {
        let client = http_client()?;
        let _ = oauth::revoke_credential(&client, &credential).await;
    }
    oauth::delete_credential(&app)?;
    Ok(CodexAuthStatus::missing())
}

#[tauri::command]
pub async fn codex_send_message(
    app: AppHandle,
    request: CodexChatRequest,
) -> Result<CodexChatResponse, String> {
    let client = http_client()?;
    let credential = oauth::ensure_fresh_credential(&app, &client).await?;
    let body = build_request(&request);

    let mut http_request = client
        .post(RESPONSES_ENDPOINT)
        .timeout(REQUEST_TIMEOUT)
        .json(&body);

    for (name, value) in auth_headers(&credential) {
        http_request = http_request.header(name, value);
    }

    let response = http_request
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(redacted_provider_error(status.as_u16(), &text));
    }

    let payload: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Codex вернул некорректный JSON: {error}"))?;
    let content = extract_output_text(&payload);
    let tool_calls = extract_tool_calls(&payload);
    if content.trim().is_empty() && tool_calls.is_empty() {
        return Err("Codex вернул пустой ответ".to_string());
    }

    Ok(CodexChatResponse {
        content,
        tool_calls,
    })
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())
}

fn auth_headers(credential: &oauth::CodexCredential) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        (
            "Authorization",
            format!("Bearer {}", credential.access_token.trim()),
        ),
        ("originator", CODEX_ORIGINATOR.to_string()),
        ("User-Agent", CODEX_USER_AGENT.to_string()),
    ];
    if let Some(account_id) = credential
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        headers.push(("ChatGPT-Account-Id", account_id.to_string()));
    }
    headers
}

fn build_request(request: &CodexChatRequest) -> Value {
    let instructions = instructions_from_messages(&request.messages);
    let input = input_from_messages(&request.messages);

    let mut body = json!({
        "model": request.model,
        "instructions": instructions,
        "input": input,
        "stream": false,
        "store": false,
    });

    if !request.tools.is_empty() {
        if let Some(object) = body.as_object_mut() {
            object.insert("tools".to_string(), Value::Array(request.tools.clone()));
            object.insert("tool_choice".to_string(), Value::String("auto".to_string()));
            object.insert("parallel_tool_calls".to_string(), Value::Bool(true));
        }
    }

    body
}

fn instructions_from_messages(messages: &[CodexChatMessage]) -> String {
    let instructions = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.trim())
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    if instructions.trim().is_empty() {
        "You are Quest Keeper AI's dungeon master.".to_string()
    } else {
        instructions
    }
}

fn input_from_messages(messages: &[CodexChatMessage]) -> Vec<Value> {
    let mut input = Vec::new();

    for message in messages.iter().filter(|message| message.role != "system") {
        match message.role.as_str() {
            "tool" => {
                if let Some(call_id) = message.tool_call_id.as_deref() {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": message.content,
                    }));
                }
            }
            "assistant" => {
                if !message.content.trim().is_empty() {
                    input.push(chat_message_input_item(
                        "assistant",
                        "output_text",
                        &message.content,
                    ));
                }
                for tool_call in &message.tool_calls {
                    input.push(function_call_input_item(tool_call));
                }
            }
            "user" => {
                if !message.content.trim().is_empty() {
                    input.push(chat_message_input_item(
                        "user",
                        "input_text",
                        &message.content,
                    ));
                }
            }
            _ => {}
        }
    }

    input
}

fn chat_message_input_item(role: &str, kind: &str, content: &str) -> Value {
    json!({
        "role": role,
        "content": [{ "type": kind, "text": content }],
    })
}

fn function_call_input_item(tool_call: &CodexToolCall) -> Value {
    let arguments = if tool_call.arguments.is_string() {
        tool_call.arguments.as_str().unwrap_or_default().to_string()
    } else {
        tool_call.arguments.to_string()
    };

    json!({
        "type": "function_call",
        "call_id": tool_call
            .id
            .clone()
            .unwrap_or_else(|| format!("call_{}", tool_call.name)),
        "name": tool_call.name,
        "arguments": arguments,
    })
}

fn extract_output_text(value: &Value) -> String {
    let mut text = String::new();
    if let Some(output) = value.get("output").and_then(Value::as_array) {
        for item in output {
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for part in content {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                            text.push_str(chunk);
                        }
                    }
                }
            }
        }
    }
    if text.is_empty() {
        if let Some(flat) = value.get("output_text").and_then(Value::as_str) {
            text.push_str(flat);
        }
    }
    text
}

fn extract_tool_calls(value: &Value) -> Vec<CodexToolCall> {
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, item)| {
            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                return None;
            }
            let name = item.get("name").and_then(Value::as_str)?.to_string();
            if name.trim().is_empty() {
                return None;
            }
            let raw_arguments = item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = serde_json::from_str(raw_arguments).unwrap_or_else(|_| json!({}));
            let id = item
                .get("call_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| Some(format!("responses_call_{index}")));
            Some(CodexToolCall {
                id,
                name,
                arguments,
            })
        })
        .collect()
}

fn redacted_provider_error(status: u16, body: &str) -> String {
    let mut compact = body.replace('\n', " ");
    if compact.len() > 2_000 {
        compact.truncate(2_000);
        compact.push_str("...");
    }
    format!("Ошибка Codex API {status}: {compact}")
}

pub fn credential_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("codex-oauth.json"))
}
