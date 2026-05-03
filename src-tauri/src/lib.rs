pub mod single_instance;

use serde::Deserialize;
use single_instance::{AcquireError, InstanceLock};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager, WindowEvent,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayerState {
    playing: bool,
    station_name: String,
}

pub fn run() {
    let lock = match InstanceLock::acquire("gui") {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            if let AcquireError::AlreadyRunning { mode, pid } = &error {
                show_already_running_dialog(mode, *pid);
            }
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .setup(move |app| {
            app.manage(lock);
            create_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Classic Radio");
}

fn show_already_running_dialog(mode: &str, pid: u32) {
    let message = format!(
        "Classic Radio sudah berjalan dalam mode {mode} (PID {pid}).\nTutup instance itu dulu sebelum menjalankan yang baru."
    );
    let _ = std::process::Command::new("zenity")
        .args([
            "--error",
            "--title=Classic Radio",
            &format!("--text={message}"),
        ])
        .status()
        .or_else(|_| {
            std::process::Command::new("notify-send")
                .args(["Classic Radio", &message])
                .status()
        });
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let play_pause = MenuItem::with_id(app, "play-pause", "Play/Pause", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &play_pause, &previous, &next, &exit])?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)
        .tooltip("Classic Radio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "play-pause" => {
                let _ = app.emit("tray-control", "play-pause");
            }
            "previous" => {
                let _ = app.emit("tray-control", "previous");
            }
            "next" => {
                let _ = app.emit("tray-control", "next");
            }
            "exit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    let play_pause_for_state = play_pause.clone();
    let tray_for_state = tray.clone();
    app.listen("player-state", move |event| {
        if let Ok(state) = serde_json::from_str::<PlayerState>(event.payload()) {
            let label = if state.playing { "Pause" } else { "Play" };
            let tooltip = if state.station_name.is_empty() {
                "Classic Radio".to_string()
            } else {
                format!("Classic Radio - {}", state.station_name)
            };

            let _ = play_pause_for_state.set_text(label);
            let _ = tray_for_state.set_tooltip(Some(tooltip));
        }
    });

    Ok(())
}
