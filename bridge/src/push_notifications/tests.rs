//! Proof of enrollment persistence, transition semantics, and wire-format boundaries.

use super::*;
use p256::ecdsa::signature::Verifier;

/// Make a real subscriber key pair rather than a provider-shaped dummy key.
fn subscription() -> SubscriptionInfo {
    let (key, auth) = ece::generate_keypair_and_auth_secret().unwrap();
    SubscriptionInfo {
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test-token".into(),
        keys: SubscriptionKeys {
            p256dh: URL_SAFE_NO_PAD.encode(key.pub_as_raw().unwrap()),
            auth: URL_SAFE_NO_PAD.encode(auth),
        },
    }
}

/// Isolate private storage under an exclusively created test directory.
fn directory() -> PathBuf {
    let key = p256::SecretKey::random(&mut OsRng);
    let path = std::env::temp_dir().join(format!(
        "herdr-push-test-{}",
        URL_SAFE_NO_PAD.encode(key.to_bytes())
    ));
    fs::create_dir(&path).unwrap();
    path
}

/// Build only the fields a real daemon supplies for transition tracking.
fn pane(terminal: &str, status: &str) -> PaneInfo {
    serde_json::from_value(serde_json::json!({"pane_id":"p1", "terminal_id":terminal, "workspace_id":"w1", "tab_id":"t1", "focused":false, "agent_status":status, "revision":1})).unwrap()
}

#[test]
fn only_observed_working_to_blocked_or_idle_transitions_notify() {
    use AgentStatus::*;
    let mut tracker = TransitionTracker::new(&[pane("terminal1", "working")]);
    assert!(!tracker.observe("p1", Working));
    assert!(tracker.observe("p1", Blocked));
    assert!(!tracker.observe("p1", Blocked));
    assert!(!tracker.observe("p1", Idle));
    assert!(!tracker.observe("p1", Working));
    assert!(tracker.observe("p1", Idle));
    assert!(!tracker.observe("p1", Working));
    assert!(!tracker.observe("p1", Done));
    assert!(!tracker.observe("p1", Blocked));
    assert!(!tracker.observe("unknown", Idle));
}

#[test]
fn reconnect_and_terminal_replacement_do_not_invent_transitions() {
    let mut tracker = TransitionTracker::new(&[pane("old", "blocked")]);
    assert!(!tracker.observe("p1", AgentStatus::Idle));
    tracker.observe("p1", AgentStatus::Working);
    // Structural snapshots must not overwrite observed status for the same terminal.
    assert!(!tracker.reconcile(&[pane("old", "idle")]));
    assert!(tracker.observe("p1", AgentStatus::Blocked));
    assert!(tracker.reconcile(&[pane("new", "working")]));
    assert!(!tracker.observe("p1", AgentStatus::Idle));
    let mut reconnected = TransitionTracker::new(&[pane("new", "idle")]);
    assert!(!reconnected.observe("p1", AgentStatus::Idle));
}

#[test]
fn newer_snapshot_cannot_turn_older_buffered_idle_event_into_a_false_transition() {
    // The snapshot has advanced past the queued idle event to working. Only stream order is causal.
    let mut tracker = TransitionTracker::new(&[pane("terminal1", "working")]);
    assert!(!tracker.observe("p1", AgentStatus::Idle));
    assert!(!tracker.observe("p1", AgentStatus::Working));
    assert!(tracker.observe("p1", AgentStatus::Blocked));
}

#[test]
fn provider_allowlist_rejects_ssrf_redirect_origins_and_invalid_keys() {
    let mut sub = subscription();
    validate_subscription(&sub).unwrap();
    for endpoint in [
        "http://updates.push.services.mozilla.com/wpush/test",
        "https://127.0.0.1/wpush/test",
        "https://[::1]/wpush/test",
        "https://updates.push.services.mozilla.com.evil.test/wpush/test",
        "https://updates.push.services.mozilla.com@evil.test/wpush/test",
        "https://updates.push.services.mozilla.com:444/wpush/test",
        "https://updates.push.services.mozilla.com/other/test",
        "https://updates.push.services.mozilla.com/wpush/test?redirect=http://localhost",
    ] {
        assert!(validate_endpoint(endpoint).is_err(), "accepted {endpoint}");
    }
    sub.keys.p256dh = URL_SAFE_NO_PAD.encode([4u8; 65]);
    assert!(validate_subscription(&sub).is_err());
    sub = subscription();
    sub.keys.auth = URL_SAFE_NO_PAD.encode([1u8; 15]);
    assert!(validate_subscription(&sub).is_err());
}

#[test]
fn vapid_uses_provider_origin_short_expiry_and_verifiable_raw_es256_signature() {
    let key = SigningKey::random(&mut OsRng);
    let public = URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes());
    let endpoint =
        reqwest::Url::parse("https://updates.push.services.mozilla.com/wpush/v2/secret").unwrap();
    let authorization =
        vapid_authorization(&key, &public, "mailto:operator@example.com", &endpoint).unwrap();
    assert!(authorization.is_sensitive());
    let header = authorization.to_str().unwrap();
    let (jwt, public_header) = header
        .strip_prefix("vapid t=")
        .unwrap()
        .split_once(", k=")
        .unwrap();
    assert_eq!(public_header, public);
    let parts: Vec<_> = jwt.split('.').collect();
    let jwt_header: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(jwt_header, serde_json::json!({"alg":"ES256", "typ":"JWT"}));
    let claims: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["aud"], "https://updates.push.services.mozilla.com");
    assert_eq!(claims["sub"], "mailto:operator@example.com");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!((now + 3500..=now + 3600).contains(&claims["exp"].as_u64().unwrap()));
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
    assert_eq!(signature.len(), 64);
    key.verifying_key()
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &Signature::from_slice(&signature).unwrap(),
        )
        .unwrap();
}

#[test]
fn encrypted_payload_round_trips_and_uses_fresh_ephemeral_material() {
    let (key, auth) = ece::generate_keypair_and_auth_secret().unwrap();
    let mut sub = subscription();
    sub.keys = SubscriptionKeys {
        p256dh: URL_SAFE_NO_PAD.encode(key.pub_as_raw().unwrap()),
        auth: URL_SAFE_NO_PAD.encode(auth),
    };
    let first = encrypted_payload(&sub, "Agent p1 is now idle.").unwrap();
    let second = encrypted_payload(&sub, "Agent p1 is now idle.").unwrap();
    assert_ne!(first, second);
    let decrypted = ece::decrypt(&key.raw_components().unwrap(), &auth, &first).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&decrypted).unwrap(),
        serde_json::json!({"body":"Agent p1 is now idle."})
    );
    assert!(encrypted_payload(&sub, &"x".repeat(5000)).is_err());
}

#[tokio::test]
async fn enrollment_preferences_and_signing_key_survive_restart_and_expiry_is_selective() {
    let dir = directory();
    let path = dir.join("push.json");
    let sub = subscription();
    let preferences = Preferences {
        blocked: true,
        idle: false,
    };
    assert!(preferences.accepts(AgentStatus::Blocked));
    assert!(!preferences.accepts(AgentStatus::Idle));
    let (service, worker) =
        PushNotifications::start(path.clone(), "mailto:test@example.com".into()).unwrap();
    let public_key = service.public_key.clone();
    service
        .subscription(SubscriptionRequest::Save {
            subscription: sub.clone(),
            preferences,
        })
        .unwrap();
    drop(worker);
    drop(service);
    let (service, _worker) =
        PushNotifications::start(path.clone(), "mailto:test@example.com".into()).unwrap();
    assert_eq!(public_key, service.public_key);
    for status in [201, 301, 400, 401, 403, 429, 500, 503] {
        let _ = service.finish_delivery(status, &sub.endpoint).await;
        assert_eq!(
            service
                .subscription(SubscriptionRequest::Read {
                    endpoint: sub.endpoint.clone()
                })
                .unwrap()
                .preferences,
            Some(preferences)
        );
    }
    for status in [404, 410] {
        service
            .subscription(SubscriptionRequest::Save {
                subscription: sub.clone(),
                preferences,
            })
            .unwrap();
        assert!(service
            .finish_delivery(status, &sub.endpoint)
            .await
            .is_err());
        assert_eq!(
            service
                .subscription(SubscriptionRequest::Read {
                    endpoint: sub.endpoint.clone()
                })
                .unwrap()
                .preferences,
            None
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    // Corruption is reported, never replaced with a fresh signing key or empty enrollment.
    fs::write(&path, b"broken").unwrap();
    assert!(PushNotifications::start(path.clone(), "mailto:test@example.com".into()).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"broken");
    fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn transport_does_not_follow_redirects() {
    use axum::{routing::get, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/unexpected") }),
        )
        .route(
            "/unexpected",
            get(|| async { axum::http::StatusCode::INTERNAL_SERVER_ERROR }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let response = push_client()
        .unwrap()
        .get(format!("http://{address}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 307);
    server.abort();
}
