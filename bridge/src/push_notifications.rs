//! Private Web Push subscriptions, observed transitions, and bounded provider delivery.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{stream, StreamExt};
use herdr_compat::api::schema::{AgentStatus, PaneInfo};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::elliptic_curve::rand_core::OsRng;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Semaphore};

use crate::store_util::{default_store_dir, session_key, stable_hash, LockFile};

/// Maximum enrolled browsers per bridge session, bounding fanout and disk usage.
const MAX_SUBSCRIPTIONS: usize = 32;
/// Discard stale queued events rather than delivering old attention requests.
const MAX_AGE: Duration = Duration::from_secs(60);

/// Standard PushSubscription JSON. expirationTime is browser-owned and intentionally ignored.
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SubscriptionInfo {
    endpoint: String,
    keys: SubscriptionKeys,
}

/// RFC 8291 subscriber key agreement material, validated before storage.
#[derive(Clone, Deserialize, Serialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

/// Independently selected working-to-blocked and working-to-idle transitions.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Preferences {
    pub blocked: bool,
    pub idle: bool,
}

impl Preferences {
    /// Whether this browser requested the observed destination state.
    fn accepts(self, status: AgentStatus) -> bool {
        match status {
            AgentStatus::Blocked => self.blocked,
            AgentStatus::Idle => self.idle,
            _ => false,
        }
    }
}

/// Browser-owned subscription and the bridge-side delivery preferences.
#[derive(Clone, Deserialize, Serialize)]
struct Enrollment {
    subscription: SubscriptionInfo,
    preferences: Preferences,
}

/// Session-private signing material and subscriptions. Never returned to browsers.
#[derive(Deserialize, Serialize)]
struct Store {
    version: u32,
    private_key: String,
    enrollments: Vec<Enrollment>,
}

/// A bounded queue entry containing no terminal output or agent-supplied text.
struct Notice {
    pane_id: String,
    status: AgentStatus,
    observed_at: Instant,
}

/// API mutations use POST so delivery addresses never enter URL/access logs.
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SubscriptionRequest {
    Read {
        endpoint: String,
    },
    Save {
        subscription: SubscriptionInfo,
        preferences: Preferences,
    },
    Remove {
        endpoint: String,
    },
    Test {
        endpoint: String,
    },
}

/// Only the public signing key is exposed during enrollment.
#[derive(Serialize)]
pub(crate) struct PushConfig {
    pub public_key: Option<String>,
}

/// Absence means this browser has not enrolled on this bridge.
#[derive(Serialize)]
pub(crate) struct SubscriptionResponse {
    pub preferences: Option<Preferences>,
}

/// Delivery lifetime owned by run_server, including cancellation on startup failure.
pub(crate) struct PushWorker(tokio::task::JoinHandle<()>);

impl Drop for PushWorker {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One session's private store and bounded outbound delivery resources.
pub(crate) struct PushNotifications {
    path: PathBuf,
    subject: String,
    public_key: String,
    signing_key: SigningKey,
    client: reqwest::Client,
    slots: Semaphore,
    queue: mpsc::Sender<Notice>,
}

impl PushNotifications {
    /// Enable explicitly with an operator contact. No enrollment or key generation otherwise.
    pub(crate) fn from_env() -> io::Result<Option<(Arc<Self>, PushWorker)>> {
        let Ok(subject) = std::env::var("HERDR_WEB_PUSH_SUBJECT") else {
            return Ok(None);
        };
        if !subject.starts_with("mailto:")
            || !subject[7..].contains('@')
            || subject.chars().any(char::is_whitespace)
        {
            return Err(invalid(
                "HERDR_WEB_PUSH_SUBJECT must be a mailto: contact address",
            ));
        }
        let directory = default_store_dir("HERDR_WEB_PUSH_DIR", "push", ".herdr-web-push");
        let path = directory.join(format!("{:016x}.json", stable_hash(&session_key())));
        Self::start(path, subject).map(Some)
    }

    /// Initialize signing material under a cross-process lock before accepting browsers.
    fn start(path: PathBuf, subject: String) -> io::Result<(Arc<Self>, PushWorker)> {
        let (queue, mut receiver) = mpsc::channel::<Notice>(64);
        let mut service = Self {
            path,
            subject,
            public_key: String::new(),
            signing_key: SigningKey::random(&mut OsRng),
            client: push_client()?,
            slots: Semaphore::new(4),
            queue,
        };
        service.signing_key = service.with_store(|store| {
            let bytes = URL_SAFE_NO_PAD
                .decode(&store.private_key)
                .map_err(|_| invalid("Invalid push signing key"))?;
            SigningKey::from_slice(&bytes).map_err(|_| invalid("Invalid push signing key"))
        })?;
        service.public_key = URL_SAFE_NO_PAD.encode(
            service
                .signing_key
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes(),
        );
        let service = Arc::new(service);
        let worker_service = service.clone();
        let worker = tokio::spawn(async move {
            while let Some(notice) = receiver.recv().await {
                // Read current preferences at delivery time, honoring removals and updates.
                if notice.observed_at.elapsed() > MAX_AGE {
                    continue;
                }
                let reader = worker_service.clone();
                let enrollments = tokio::task::spawn_blocking(move || {
                    reader.with_store(|store| Ok(store.enrollments.clone()))
                })
                .await;
                match enrollments {
                    Ok(Ok(enrollments)) => {
                        stream::iter(
                            enrollments
                                .into_iter()
                                .filter(|e| e.preferences.accepts(notice.status)),
                        )
                        .for_each_concurrent(4, |enrollment| {
                            let service = &worker_service;
                            let notice = &notice;
                            async move {
                                if notice.observed_at.elapsed() <= MAX_AGE {
                                    let status = if notice.status == AgentStatus::Blocked {
                                        "blocked"
                                    } else {
                                        "idle"
                                    };
                                    let body = format!("Agent {} is now {status}.", notice.pane_id);
                                    if let Err(error) =
                                        service.send(&enrollment.subscription, &body).await
                                    {
                                        tracing::warn!(error = %error, "Web Push delivery failed");
                                    }
                                }
                            }
                        })
                        .await;
                    }
                    _ => tracing::error!("Could not read private Web Push subscriptions"),
                }
            }
        });
        Ok((service, PushWorker(worker)))
    }

    /// Report disabled service without manufacturing a browser subscription.
    pub(crate) fn config(service: Option<&Self>) -> PushConfig {
        PushConfig {
            public_key: service.map(|s| s.public_key.clone()),
        }
    }

    /// Nonblocking handoff from the synchronous daemon watcher. Queue overflow is visible.
    pub(crate) fn notify(&self, pane_id: &str, status: AgentStatus) {
        if self
            .queue
            .try_send(Notice {
                pane_id: pane_id.to_string(),
                status,
                observed_at: Instant::now(),
            })
            .is_err()
        {
            tracing::warn!("Web Push queue full or stopped; notification dropped");
        }
    }

    /// Read or mutate only the caller's endpoint, never enumerate other browsers.
    pub(crate) fn subscription(
        &self,
        request: SubscriptionRequest,
    ) -> io::Result<SubscriptionResponse> {
        let preferences = self.with_store(|store| match request {
            SubscriptionRequest::Read { endpoint } | SubscriptionRequest::Test { endpoint } => {
                validate_endpoint(&endpoint)?;
                Ok(store
                    .enrollments
                    .iter()
                    .find(|e| e.subscription.endpoint == endpoint)
                    .map(|e| e.preferences))
            }
            SubscriptionRequest::Remove { endpoint } => {
                validate_endpoint(&endpoint)?;
                store
                    .enrollments
                    .retain(|e| e.subscription.endpoint != endpoint);
                Ok(None)
            }
            SubscriptionRequest::Save {
                subscription,
                preferences,
            } => {
                validate_subscription(&subscription)?;
                if let Some(existing) = store
                    .enrollments
                    .iter_mut()
                    .find(|e| e.subscription.endpoint == subscription.endpoint)
                {
                    *existing = Enrollment {
                        subscription,
                        preferences,
                    };
                } else {
                    if store.enrollments.len() >= MAX_SUBSCRIPTIONS {
                        return Err(invalid("Web Push browser limit reached (32)"));
                    }
                    store.enrollments.push(Enrollment {
                        subscription,
                        preferences,
                    });
                }
                Ok(Some(preferences))
            }
        })?;
        Ok(SubscriptionResponse { preferences })
    }

    /// Send a real encrypted test through the provider, only for an enrolled endpoint.
    pub(crate) async fn test(self: &Arc<Self>, endpoint: String) -> io::Result<()> {
        let reader = self.clone();
        let subscription = tokio::task::spawn_blocking(move || {
            reader.with_store(|store| {
                store
                    .enrollments
                    .iter()
                    .find(|e| e.subscription.endpoint == endpoint)
                    .map(|e| e.subscription.clone())
                    .ok_or_else(|| invalid("Enable notifications before sending a test"))
            })
        })
        .await
        .map_err(|_| io::Error::other("Push storage task failed"))??;
        self.send(
            &subscription,
            "Herdr test notification. Push delivery is working.",
        )
        .await
    }

    /// Encrypt locally and contact only validated providers, with no redirects or unbounded waits.
    async fn send(self: &Arc<Self>, subscription: &SubscriptionInfo, body: &str) -> io::Result<()> {
        let _slot = self
            .slots
            .try_acquire()
            .map_err(|_| io::Error::other("Push delivery busy; retry shortly"))?;
        let url = reqwest::Url::parse(&subscription.endpoint)
            .map_err(|_| invalid("Invalid push endpoint"))?;
        let authorization =
            vapid_authorization(&self.signing_key, &self.public_key, &self.subject, &url)?;
        let payload = encrypted_payload(subscription, body)?;
        let response = self
            .client
            .post(url)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header("Content-Encoding", "aes128gcm")
            .header("TTL", "60")
            .body(payload)
            .send()
            .await
            .map_err(|_| io::Error::other("Push provider connection failed or timed out"))?;
        let status = response.status();
        self.finish_delivery(status.as_u16(), &subscription.endpoint)
            .await
    }

    /// Forget only definitive expiry. Provider failures must not silently disable enrollment.
    async fn finish_delivery(self: &Arc<Self>, status: u16, endpoint: &str) -> io::Result<()> {
        // Never read or log provider response bodies, request URLs, or subscriber credentials.
        if matches!(status, 404 | 410) {
            let service = self.clone();
            let endpoint = endpoint.to_string();
            tokio::task::spawn_blocking(move || {
                service.subscription(SubscriptionRequest::Remove { endpoint })
            })
            .await
            .map_err(|_| io::Error::other("Push storage task failed"))??;
        }
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "Push provider returned HTTP {status}"
            )))
        }
    }

    /// Serialize read-modify-write across bridge processes and atomically replace owner-only JSON.
    fn with_store<T>(&self, operation: impl FnOnce(&mut Store) -> io::Result<T>) -> io::Result<T> {
        let _lock = LockFile::exclusive(&self.path.with_extension("lock"))?;
        let mut store = match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<Store>(&bytes)
                .map_err(|_| invalid("Invalid private Web Push store; file preserved"))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Store {
                version: 1,
                private_key: URL_SAFE_NO_PAD.encode(p256::SecretKey::random(&mut OsRng).to_bytes()),
                enrollments: Vec::new(),
            },
            Err(error) => return Err(error),
        };
        if store.version != 1 || store.enrollments.len() > MAX_SUBSCRIPTIONS {
            return Err(invalid("Unsupported private Web Push store"));
        }
        for enrollment in &store.enrollments {
            validate_subscription(&enrollment.subscription)?;
        }
        let before = serde_json::to_vec(&store).map_err(io::Error::other)?;
        let result = operation(&mut store)?;
        let after = serde_json::to_vec(&store).map_err(io::Error::other)?;
        if before != after || !self.path.exists() {
            // The lock serializes writers; create_new refuses an unexpected existing temp file.
            let temp = self
                .path
                .with_extension(format!("{}.tmp", std::process::id()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            let write = (|| {
                file.write_all(&after)?;
                file.sync_all()?;
                fs::rename(&temp, &self.path)
            })();
            if write.is_err() {
                let _ = fs::remove_file(&temp);
            }
            write?;
        }
        Ok(result)
    }
}

/// Disable redirects and ambient proxies so opaque endpoint credentials stay with their provider.
fn push_client() -> io::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| io::Error::other("Could not initialize Web Push HTTPS transport"))
}

/// Fixed ES256 VAPID claims. JWT signatures use raw r||s, not ASN.1 DER.
fn vapid_authorization(
    key: &SigningKey,
    public_key: &str,
    subject: &str,
    endpoint: &reqwest::Url,
) -> io::Result<reqwest::header::HeaderValue> {
    let expiration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io::Error::other("Invalid system clock"))?
        .as_secs()
        + 3600;
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "aud": endpoint.origin().ascii_serialization(), "exp": expiration, "sub": subject,
        }))
        .map_err(io::Error::other)?,
    );
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = key.sign(signing_input.as_bytes());
    let jwt = format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("vapid t={jwt}, k={public_key}"))
            .map_err(|_| invalid("Cannot encode VAPID authorization"))?;
    authorization.set_sensitive(true);
    Ok(authorization)
}

/// Delegate ephemeral ECDH, encryption, and aes128gcm framing entirely to Mozilla's ece.
fn encrypted_payload(subscription: &SubscriptionInfo, body: &str) -> io::Result<Vec<u8>> {
    let public = URL_SAFE_NO_PAD
        .decode(&subscription.keys.p256dh)
        .map_err(|_| invalid("Invalid push public key"))?;
    let auth = URL_SAFE_NO_PAD
        .decode(&subscription.keys.auth)
        .map_err(|_| invalid("Invalid push auth key"))?;
    let payload =
        serde_json::to_vec(&serde_json::json!({"body": body})).map_err(io::Error::other)?;
    let encrypted = ece::encrypt(&public, &auth, &payload)
        .map_err(|_| invalid("Cannot encrypt push notification"))?;
    if encrypted.len() > 4096 {
        return Err(invalid("Push payload exceeds provider limits"));
    }
    Ok(encrypted)
}

/// Reject arbitrary callback URLs so enrollment cannot turn the bridge into an SSRF proxy.
fn validate_endpoint(endpoint: &str) -> io::Result<()> {
    let uri: axum::http::Uri = endpoint
        .parse()
        .map_err(|_| invalid("Invalid push endpoint"))?;
    let allowed = match uri.authority().map(|a| a.as_str()) {
        Some("updates.push.services.mozilla.com") => uri.path().starts_with("/wpush/"),
        Some("fcm.googleapis.com") => uri.path().starts_with("/fcm/send/"),
        _ => false,
    };
    if endpoint.len() > 4096
        || uri.scheme_str() != Some("https")
        || !allowed
        || uri.query().is_some()
    {
        return Err(invalid(
            "Only HTTPS Mozilla and Firebase Web Push endpoints are supported",
        ));
    }
    Ok(())
}

/// Check the real Web Push encryption key formats before persisting untrusted input.
fn validate_subscription(subscription: &SubscriptionInfo) -> io::Result<()> {
    validate_endpoint(&subscription.endpoint)?;
    let public = URL_SAFE_NO_PAD
        .decode(&subscription.keys.p256dh)
        .map_err(|_| invalid("Invalid push public key"))?;
    let auth = URL_SAFE_NO_PAD
        .decode(&subscription.keys.auth)
        .map_err(|_| invalid("Invalid push auth key"))?;
    if public.len() != 65
        || public[0] != 4
        || p256::PublicKey::from_sec1_bytes(&public).is_err()
        || auth.len() != 16
    {
        return Err(invalid("Invalid Web Push encryption keys"));
    }
    Ok(())
}

/// Input errors are intentionally static and cannot leak delivery credentials.
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Per-subscription baseline. Bootstrap, reconnect, and terminal replacement are not transitions.
pub(crate) struct TransitionTracker(HashMap<String, (String, AgentStatus)>);

impl TransitionTracker {
    /// Establish an authoritative baseline without emitting startup notifications.
    pub(crate) fn new(panes: &[PaneInfo]) -> Self {
        Self(
            panes
                .iter()
                .map(|p| (p.pane_id.clone(), (p.terminal_id.clone(), p.agent_status)))
                .collect(),
        )
    }

    /// Forget replaced terminals without overwriting observed states with browser snapshots.
    pub(crate) fn reconcile(&mut self, panes: &[PaneInfo]) -> bool {
        let previous_len = self.0.len();
        self.0.retain(|id, (terminal, _)| {
            panes
                .iter()
                .any(|p| &p.pane_id == id && &p.terminal_id == terminal)
        });
        self.0.len() != previous_len
    }

    /// Consume each status once, notifying only the two requested working transitions.
    pub(crate) fn observe(&mut self, pane_id: &str, status: AgentStatus) -> bool {
        let Some((_, previous)) = self.0.get_mut(pane_id) else {
            return false;
        };
        let notify = *previous == AgentStatus::Working
            && matches!(status, AgentStatus::Blocked | AgentStatus::Idle);
        *previous = status;
        notify
    }
}

#[cfg(test)]
mod tests;
