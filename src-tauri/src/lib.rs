// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod codex;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            codex::codex_auth_status,
            codex::codex_authenticate,
            codex::codex_logout,
            codex::codex_send_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
