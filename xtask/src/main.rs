use std::{
    env,
    error::Error,
    io,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const SERVER_PACKAGE: &str = "webrtc-camera-share-server";

fn main() -> Result<(), Box<dyn Error>> {
    let root = workspace_root()?;
    match env::args().nth(1).as_deref() {
        Some("dev") => dev(&root),
        Some("verify") => verify(&root),
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
            stop_child(&mut server);
            return Err(error.into());
        }
    };

    println!("development services started; press Ctrl+C to stop both");
    loop {
        if stopping.load(Ordering::SeqCst) {
            stop_child(&mut server);
            stop_child(&mut web);
            return Ok(());
        }
        if let Some(status) = server.try_wait()? {
            stop_child(&mut web);
            return child_result("Rust server", status);
        }
        if let Some(status) = web.try_wait()? {
            stop_child(&mut server);
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

fn stop_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
        let _ = child.wait();
    }
}
