use std::{
    env,
    error::Error,
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const SERVER_PACKAGE: &str = "webrtc-camera-share-server";

fn main() -> Result<(), Box<dyn Error>> {
    let root = workspace_root()?;
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        Some("dev") => dev(&root),
        Some("verify") => verify(&root),
        Some("e2e") => e2e(&root),
        Some("smoke") => smoke(&root, &arguments[1..]),
        Some("build") => build(&root, false),
        Some("release") => build(&root, true),
        Some("help" | "--help" | "-h") | None => {
            print_help();
            Ok(())
        }
        Some(command) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unknown xtask command: {command}"),
        )
        .into()),
    }
}

fn workspace_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("xtask must live inside the workspace").into())
}

fn print_help() {
    println!(
        "\
Project workflows:
  cargo xtask dev      Start the Rust server and Vite development server
  cargo xtask verify   Install locked frontend dependencies and run all checks
  cargo xtask e2e      Run isolated Chromium UI and WebRTC acceptance tests
  cargo xtask smoke -- <binary>
                        Launch a release binary and verify production endpoints
  cargo xtask build    Build the frontend and filesystem-backed Rust release
  cargo xtask release  Build a standalone Rust release with embedded frontend"
    );
}

fn dev(root: &Path) -> Result<(), Box<dyn Error>> {
    let stopping = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&stopping);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;

    let mut server = Command::new("cargo")
        .args(["run", "--package", SERVER_PACKAGE])
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut web = match Command::new("bun")
        .args(["run", "--cwd", "apps/web", "dev"])
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            stop_child(&mut server).map_err(|cleanup_error| {
                io::Error::other(format!(
                    "failed to start Vite: {error}; Rust server cleanup also failed: {cleanup_error}"
                ))
            })?;
            return Err(error.into());
        }
    };

    println!("development services started; press Ctrl+C to stop both");
    loop {
        if stopping.load(Ordering::SeqCst) {
            stop_children(&mut [&mut server, &mut web])?;
            return Ok(());
        }
        if let Some(status) = server.try_wait()? {
            stop_child(&mut web)?;
            return child_result("Rust server", status);
        }
        if let Some(status) = web.try_wait()? {
            stop_child(&mut server)?;
            return child_result("Vite server", status);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn verify(root: &Path) -> Result<(), Box<dyn Error>> {
    run(root, "bun", &["install", "--frozen-lockfile"])?;
    run(root, "bun", &["run", "--cwd", "apps/web", "typecheck"])?;
    run(root, "bun", &["run", "--cwd", "apps/web", "lint"])?;
    run(root, "bun", &["run", "--cwd", "apps/web", "test"])?;
    build_web(root)?;
    run(root, "cargo", &["fmt", "--all", "--check"])?;
    run(
        root,
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ],
    )?;
    run(
        root,
        "cargo",
        &[
            "clippy",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ],
    )?;
    run(root, "cargo", &["test", "--workspace"])?;
    run(root, "cargo", &["test", "--workspace", "--all-features"])
}

fn e2e(root: &Path) -> Result<(), Box<dyn Error>> {
    build_web(root)?;
    run(root, "cargo", &["build", "--package", SERVER_PACKAGE])?;

    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let address = listener.local_addr()?;
    drop(listener);

    let executable = debug_server_executable(root);
    let web_dist = root.join("apps/web/dist");
    let mut server = Command::new(&executable)
        .current_dir(root)
        .env("HOST", "127.0.0.1")
        .env("PORT", address.port().to_string())
        .env("WEB_DIST", web_dist)
        .env("ICE_SERVERS_JSON", r#"[{"urls":"stun:127.0.0.1:9"}]"#)
        .env("RUST_LOG", "webrtc_camera_share_server=warn")
        .env_remove("TURN_URLS_JSON")
        .env_remove("TURN_SHARED_SECRET")
        .env_remove("TURN_TTL_SECONDS")
        .env_remove("ALLOWED_ORIGINS_JSON")
        .env_remove("METRICS_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to start {}: {error}", executable.display()),
            )
        })?;

    let result = (|| {
        wait_for_ready(&mut server, address, Duration::from_secs(20))?;
        let base_url = format!("http://{address}");
        println!("$ E2E_BASE_URL={base_url} bun run --cwd apps/web test:e2e");
        let status = Command::new("bun")
            .args(["run", "--cwd", "apps/web", "test:e2e"])
            .current_dir(root)
            .env("E2E_BASE_URL", base_url)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        child_result("Playwright", status)
    })();

    let cleanup = stop_child(&mut server);
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error.into()),
        (Err(test_error), Err(cleanup_error)) => Err(io::Error::other(format!(
            "{test_error}; test server cleanup also failed: {cleanup_error}"
        ))
        .into()),
    }
}

fn smoke(root: &Path, arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let arguments = arguments
        .strip_prefix(&["--".to_owned()])
        .unwrap_or(arguments);
    let [binary] = arguments else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: cargo xtask smoke -- <binary>",
        )
        .into());
    };
    run(
        root,
        "python",
        &["-X", "utf8", "scripts/smoke.py", "--binary", binary],
    )
}

fn debug_server_executable(root: &Path) -> PathBuf {
    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .unwrap_or_else(|| root.join("target"));
    target_dir
        .join("debug")
        .join(format!("{SERVER_PACKAGE}{}", env::consts::EXE_SUFFIX))
}

fn wait_for_ready(
    server: &mut Child,
    address: SocketAddr,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = server.try_wait()? {
            return Err(io::Error::other(format!(
                "test server exited before readiness with {status}"
            ))
            .into());
        }
        if ready_response(address).unwrap_or(false) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("test server did not become ready at http://{address}/ready"),
            )
            .into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn ready_response(address: SocketAddr) -> io::Result<bool> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_millis(500)))?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    write!(
        stream,
        "GET /ready HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = [0_u8; 1024];
    let length = stream.read(&mut response)?;
    Ok(String::from_utf8_lossy(&response[..length]).starts_with("HTTP/1.1 200"))
}

fn build(root: &Path, embedded: bool) -> Result<(), Box<dyn Error>> {
    build_web(root)?;
    let mut arguments = vec!["build", "--package", SERVER_PACKAGE, "--release"];
    if embedded {
        arguments.extend(["--features", "embed-web"]);
    }
    run(root, "cargo", &arguments)
}

fn build_web(root: &Path) -> Result<(), Box<dyn Error>> {
    run(root, "bun", &["run", "--cwd", "apps/web", "build"])
}

fn run(root: &Path, program: &str, arguments: &[&str]) -> Result<(), Box<dyn Error>> {
    println!("$ {program} {}", arguments.join(" "));
    let status = Command::new(program)
        .args(arguments)
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    child_result(program, status)
}

fn child_result(name: &str, status: ExitStatus) -> Result<(), Box<dyn Error>> {
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("{name} exited with {status}")).into())
    }
}

fn stop_child(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_none() {
        if let Err(error) = child.kill()
            && child.try_wait()?.is_none()
        {
            return Err(error);
        }
        child.wait()?;
    }
    Ok(())
}

fn stop_children(children: &mut [&mut Child]) -> io::Result<()> {
    let mut first_error = None;
    for child in children {
        if let Err(error) = stop_child(child)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}
