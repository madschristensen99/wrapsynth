use anyhow::{Context, Result};
use reqwest::Client;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use tokio::time::{sleep, Duration};
use tracing::{info, warn, debug};

/// Manages an auto-started monero-wallet-rpc instance for the LP node.
///
/// When `MONERO_WALLET_RPC_URL` is not set, the LP node can spawn its own
/// wallet-rpc, create a wallet from the LP's spend key, and keep it running.
/// The process is killed when this struct is dropped.
pub struct WalletRpcManager {
    _process: Child,
    rpc_url: String,
}

impl WalletRpcManager {
    /// Auto-start monero-wallet-rpc if one is not already running.
    ///
    /// 1. If `wallet_rpc_url` is Some, check health AND verify it can perform
    ///    wallet operations (has --wallet-dir). If both pass, return None.
    /// 2. Otherwise, spawn a new wallet-rpc process.
    /// 3. Create wallet from keys if it doesn't exist.
    /// 4. Open and refresh the wallet.
    /// 5. Return the manager (Drop will kill the process on exit).
    pub async fn auto_start(
        wallet_rpc_url: Option<&str>,
        daemon_url: &str,
        wallet_dir: &str,
        spend_key_hex: &str,
        view_key_hex: &str,
        address: &str,
    ) -> Result<Option<Self>> {
        // 1. If an existing URL is provided, verify it is healthy AND can do wallet ops.
        if let Some(url) = wallet_rpc_url {
            let client = Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .context("Failed to build HTTP client")?;
            if Self::is_healthy(url, &client).await {
                // Health check passed — but can it actually create/import wallets?
                // Test by calling generate_from_keys with a dummy wallet name.
                let test_result = Self::rpc_call(
                    url,
                    &client,
                    "generate_from_keys",
                    serde_json::json!({
                        "filename": "__wrapsynth_test_wallet__",
                        "address": "42bj1sJ9n2z8ZAe1YaXyTbwQ6N7LRSytrGY5NKkbsV17eYYp1xaRVhNuZWHmWM4H9v7CermBzjcUiPV1B71CRdez2i2d4rV",
                        "viewkey": "0000000000000000000000000000000000000000000000000000000000000000",
                        "password": "",
                        "language": "English",
                        "restore_height": 1
                    }),
                ).await;

                match test_result {
                    Ok(_) => {
                        info!("External wallet RPC at {} is healthy and can create wallets", url);
                        // Clean up test wallet (ignore errors — test wallet may not exist)
                        let _ = Self::rpc_call(
                            url, &client, "close_wallet", serde_json::json!({})
                        ).await;
                        return Ok(None);
                    }
                    Err(e) => {
                        let err_str = e.to_string();
                        if err_str.contains("No wallet dir configured")
                            || err_str.contains("wallet dir")
                            || err_str.contains("--wallet-dir")
                        {
                            warn!(
                                "External wallet RPC at {} has no --wallet-dir; will auto-start a local one",
                                url
                            );
                        } else if err_str.contains("already exists") {
                            info!("External wallet RPC at {} is functional (test wallet already exists)", url);
                            return Ok(None);
                        } else {
                            warn!(
                                "External wallet RPC at {} failed wallet ops test ({}); will auto-start a local one",
                                url, e
                            );
                        }
                    }
                }
            } else {
                warn!(
                    "Configured wallet RPC at {} is not responding, will auto-start",
                    url
                );
            }
        }

        // 2. Find the monero-wallet-rpc binary.
        let binary_path = Self::find_binary("monero-wallet-rpc")
            .context("monero-wallet-rpc binary not found. Please install Monero CLI tools: https://getmonero.org/downloads/")?;
        info!("Found monero-wallet-rpc at: {}", binary_path);

        // 3. Prepare directories and settings.
        std::fs::create_dir_all(wallet_dir)
            .with_context(|| format!("Failed to create wallet dir: {}", wallet_dir))?;

        let wallet_name = "wrapsynth_lp";
        let wallet_password = "wrapsynth123"; // local-only, rpc is localhost-only

        // Find a working daemon — try primary then fallbacks.
        let working_daemon = Self::find_working_daemon(daemon_url).await;
        let effective_daemon_url = working_daemon.as_deref().unwrap_or(daemon_url);

        // Strip protocol from daemon URL for --daemon-address.
        let daemon_addr = Self::extract_host_port(effective_daemon_url)
            .unwrap_or_else(|| effective_daemon_url.to_string());

        // Determine SSL setting based on daemon URL scheme.
        // monero-wallet-rpc accepts: enabled | disabled | autodetect
        let ssl_arg = if effective_daemon_url.starts_with("https://") {
            "enabled"
        } else {
            "disabled"
        };

        info!(
            "Spawning monero-wallet-rpc with daemon {} (ssl: {}) ...",
            daemon_addr, ssl_arg
        );

        // 4. Spawn process, create/open wallet with retry on SSL mismatch.
        let (process, rpc_url) = Self::spawn_and_setup_wallet(
            &binary_path,
            wallet_dir,
            wallet_name,
            wallet_password,
            &daemon_addr,
            ssl_arg,
            spend_key_hex,
            view_key_hex,
            address,
        ).await?;

        let manager = WalletRpcManager {
            _process: process,
            rpc_url: rpc_url.clone(),
        };

        // 8. Start a background refresh so the wallet begins syncing.
        // We use a short-timeout fire-and-forget refresh; the swap wallets
        // created later will do their own targeted refresh with recent restore_height.
        let short_client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .context("Failed to build short-timeout HTTP client")?;

        info!("Starting background wallet refresh (will not block startup) ...");
        let rpc_url_clone = rpc_url.clone();
        tokio::spawn(async move {
            match Self::rpc_call(&rpc_url_clone, &short_client, "refresh", serde_json::json!({})).await {
                Ok(_) => info!("Background wallet refresh completed"),
                Err(e) => {
                    debug!("Background wallet refresh did not complete ({}), swap wallets will refresh on demand", e);
                }
            }
        });

        info!("Auto-started monero-wallet-rpc ready at {}", rpc_url);
        Ok(Some(manager))
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// Poll wallet-rpc health.
    async fn is_healthy(url: &str, client: &Client) -> bool {
        match Self::rpc_call(url, client, "get_version", serde_json::json!({})).await {
            Ok(_) => true,
            Err(e) => {
                debug!("Wallet RPC health check failed: {}", e);
                false
            }
        }
    }

    /// Simple JSON-RPC helper.
    async fn rpc_call(
        url: &str,
        client: &Client,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let response = client
            .post(url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": "0",
                "method": method,
                "params": params
            }))
            .send()
            .await
            .with_context(|| format!("Failed to call wallet RPC method {} at {}", method, url))?;

        let body: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse wallet RPC response")?;

        if let Some(error) = body.get("error") {
            // Monero wallet RPC sometimes returns {"code":0,"message":""} which is actually success
            let is_false_error = error.get("code").and_then(|c| c.as_i64()) == Some(0);
            if !is_false_error {
                anyhow::bail!("Wallet RPC error for method {}: {}", method, error);
            }
        }

        let result = body
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok(result)
    }

    /// Find a working Monero daemon by testing get_block_count on primary + fallbacks.
    async fn find_working_daemon(primary: &str) -> Option<String> {
        let fallbacks = [
            "https://xmr-node.cakewallet.com:18081",
            "https://node.sethforprivacy.com",
            "https://connect.xmr-node.org",
            "https://rpc.monerosafe.com",
            "https://node.mon3ro.com",
            "https://xmr.hexide.com",
            "https://monero.econanon.com:443",
            "https://monerorpc.scentle5s.net",
            "https://node.xmr.surf",
            "https://xmr.visnova.pl",
            "https://xmr.unshakled.net:443",
            "https://xmr.cryptostorm.is",
        ];

        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;

        let urls: Vec<&str> = std::iter::once(primary)
            .chain(fallbacks.iter().copied())
            .collect();

        for url in urls {
            let rpc_url = format!("{}/json_rpc", url);
            match client
                .post(&rpc_url)
                .json(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": "0",
                    "method": "get_block_count"
                }))
                .send()
                .await
            {
                Ok(resp) => {
                    if let Ok(body) = resp.json::<serde_json::Value>().await {
                        if body.get("error").is_none() && body.get("result").is_some() {
                            info!("Found working Monero daemon for wallet RPC: {}", url);
                            return Some(url.to_string());
                        }
                    }
                }
                Err(e) => {
                    debug!("Daemon {} not reachable: {}", url, e);
                }
            }
        }

        warn!("No working Monero daemon found for wallet RPC");
        None
    }

    /// Get current blockchain height from daemon
    async fn get_daemon_height(daemon_url: &str) -> Result<u64> {
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .context("Failed to build HTTP client")?;

        let rpc_url = format!("{}/json_rpc", daemon_url);
        let response = client
            .post(&rpc_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": "0",
                "method": "get_block_count"
            }))
            .send()
            .await
            .context("Failed to get daemon height")?;

        let body: serde_json::Value = response.json().await?;
        let height = body
            .get("result")
            .and_then(|r| r.get("count"))
            .and_then(|c| c.as_u64())
            .ok_or_else(|| anyhow::anyhow!("Invalid daemon height response"))?;

        Ok(height)
    }

    /// Spawn monero-wallet-rpc, wait for health, create/open wallet.
    /// If open_wallet fails due to SSL/daemon config mismatch, kills the process,
    /// deletes wallet files, and retries once with a fresh process.
    async fn spawn_and_setup_wallet(
        binary_path: &str,
        wallet_dir: &str,
        wallet_name: &str,
        wallet_password: &str,
        daemon_addr: &str,
        ssl_arg: &str,
        spend_key_hex: &str,
        view_key_hex: &str,
        address: &str,
    ) -> Result<(Child, String)> {
        let port = Self::find_free_port(28382)?;
        let rpc_url = format!("http://127.0.0.1:{}/json_rpc", port);

        // Get current blockchain height for restore_height
        let daemon_url = if ssl_arg == "enabled" {
            format!("https://{}", daemon_addr)
        } else {
            format!("http://{}", daemon_addr)
        };
        
        let restore_height = match Self::get_daemon_height(&daemon_url).await {
            Ok(height) => {
                // Use current height minus 10 blocks for speed (deposits are always very recent)
                let safe_height = height.saturating_sub(10);
                info!("Using restore_height: {} (current: {})", safe_height, height);
                safe_height
            }
            Err(e) => {
                warn!("Failed to get daemon height ({}), using default restore_height: 3690000", e);
                3690000
            }
        };

        for attempt in 1..=2 {
            // Kill any existing monero-wallet-rpc processes using the same wallet-dir
            // to prevent file lock conflicts from zombie processes.
            if attempt == 1 {
                info!("Cleaning up any existing wallet RPC processes for wallet-dir: {}", wallet_dir);
                // Kill any auto-started wallet RPC processes (on ports 28382+)
                let _ = Command::new("pkill")
                    .arg("-9")
                    .arg("-f")
                    .arg("rpc-bind-port 2838")
                    .status();
                sleep(Duration::from_secs(3)).await;
            }

            // Spawn the process.
            let mut cmd = Command::new(binary_path);
            cmd.arg("--wallet-dir")
                .arg(wallet_dir)
                .arg("--rpc-bind-port")
                .arg(port.to_string())
                .arg("--rpc-bind-ip")
                .arg("127.0.0.1")
                .arg("--daemon-address")
                .arg(daemon_addr)
                .arg("--trusted-daemon")
                .arg("--daemon-ssl")
                .arg(ssl_arg)
                .arg("--daemon-ssl-allow-any-cert")
                .arg("--disable-rpc-login")
                .arg("--non-interactive")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            let mut process = cmd
                .spawn()
                .with_context(|| format!("Failed to spawn monero-wallet-rpc from {}", binary_path))?;

            let pid = process.id();
            info!("monero-wallet-rpc started (PID: {}) attempt {}", pid, attempt);

            // Wait for RPC to be ready.
            let client = Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .context("Failed to build HTTP client")?;

            let mut ready = false;
            for health_attempt in 1..=30 {
                sleep(Duration::from_millis(500)).await;
                if Self::is_healthy(&rpc_url, &client).await {
                    ready = true;
                    info!("monero-wallet-rpc ready after {} health attempts", health_attempt);
                    break;
                }
            }

            if !ready {
                warn!("monero-wallet-rpc did not become ready, killing and retrying...");
                let _ = process.kill();
                if attempt == 2 {
                    anyhow::bail!("monero-wallet-rpc failed to become ready after 2 attempts");
                }
                sleep(Duration::from_secs(1)).await;
                continue;
            }

            // Create wallet if it doesn't exist.
            let wallet_file = Path::new(wallet_dir).join(format!("{}.keys", wallet_name));
            if !wallet_file.exists() || attempt > 1 {
                info!("Creating wallet via generate_from_keys ...");
                match Self::rpc_call(
                    &rpc_url,
                    &client,
                    "generate_from_keys",
                    serde_json::json!({
                        "filename": wallet_name,
                        "address": address,
                        "spendkey": spend_key_hex,
                        "viewkey": view_key_hex,
                        "password": wallet_password,
                        "language": "English",
                        "restore_height": restore_height
                    }),
                ).await {
                    Ok(_) => info!("Wallet created successfully"),
                    Err(e) => {
                        let err_str = e.to_string();
                        if err_str.contains("already exists") {
                            info!("Wallet already exists, will try to open it");
                        } else {
                            warn!("generate_from_keys failed ({}), killing process and retrying...", e);
                            let _ = process.kill();
                            if attempt == 2 {
                                return Err(e).context("generate_from_keys failed on final attempt");
                            }
                            sleep(Duration::from_secs(1)).await;
                            continue;
                        }
                    }
                }
            }

            // Open the wallet.
            info!("Opening wallet ...");
            match Self::rpc_call(
                &rpc_url,
                &client,
                "open_wallet",
                serde_json::json!({
                    "filename": wallet_name,
                    "password": wallet_password
                }),
            ).await {
                Ok(_) => {
                    info!("Wallet opened successfully");
                    return Ok((process, rpc_url));
                }
                Err(e) => {
                    let err_str = e.to_string();
                    if (err_str.contains("daemon-ssl") || err_str.contains("Invalid argument"))
                        && attempt == 1
                    {
                        warn!("open_wallet failed due to SSL/daemon config mismatch ({}). Killing process, deleting wallet files, and retrying...", e);
                        let _ = process.kill();
                        let wallet_path = Path::new(wallet_dir).join(wallet_name);
                        let keys_path = Path::new(wallet_dir).join(format!("{}.keys", wallet_name));
                        let addr_path = Path::new(wallet_dir).join(format!("{}.address.txt", wallet_name));
                        let _ = std::fs::remove_file(&wallet_path);
                        let _ = std::fs::remove_file(&keys_path);
                        let _ = std::fs::remove_file(&addr_path);
                        sleep(Duration::from_secs(1)).await;
                        continue;
                    } else {
                        let _ = process.kill();
                        return Err(e).context("open_wallet RPC failed");
                    }
                }
            }
        }

        anyhow::bail!("Failed to spawn and setup wallet RPC after 2 attempts")
    }

    /// Search PATH for a binary.
    fn find_binary(name: &str) -> Option<String> {
        // Check current directory first
        let local = Path::new(".").join(name);
        if local.exists() {
            return Some(local.to_string_lossy().to_string());
        }

        if let Ok(paths) = std::env::var("PATH") {
            for dir in paths.split(':') {
                let path = Path::new(dir).join(name);
                if path.exists() {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
        None
    }

    /// Extract host:port from a URL like https://host:port/path
    fn extract_host_port(url: &str) -> Option<String> {
        // Remove protocol
        let without_proto = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
        // Take everything before the next path slash
        let host_port = without_proto.split('/').next()?;
        Some(host_port.to_string())
    }

    /// Find a free port starting from the given port.
    fn find_free_port(start: u16) -> Result<u16> {
        for port in start..start + 100 {
            if std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok() {
                return Ok(port);
            }
        }
        anyhow::bail!("Could not find a free port in range {}-{}", start, start + 99)
    }
}

impl Drop for WalletRpcManager {
    fn drop(&mut self) {
        let pid = self._process.id();
        info!("Shutting down auto-started monero-wallet-rpc (PID: {}) ...", pid);
        if let Err(e) = self._process.kill() {
            warn!("Failed to kill monero-wallet-rpc (PID: {}): {}", pid, e);
        } else {
            info!("monero-wallet-rpc (PID: {}) terminated", pid);
        }
    }
}
