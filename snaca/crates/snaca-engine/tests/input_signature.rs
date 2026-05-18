//! `input_signature` properties.
//!
//! The signature is keyed off a canonical JSON serialisation, so two
//! semantically-identical inputs must produce the same fingerprint
//! regardless of how the LLM happened to order keys. The migration
//! comment on `approval_decisions` calls this out — without it,
//! "Allow always" would silently re-prompt every time the provider
//! permuted JSON output.

use serde_json::json;
use snaca_engine::engine::input_signature;

#[test]
fn key_order_does_not_change_signature() {
    let a = json!({"command": "ls", "cwd": "/tmp"});
    let b = json!({"cwd": "/tmp", "command": "ls"});
    assert_eq!(
        input_signature(&a),
        input_signature(&b),
        "object key order must not affect the signature"
    );
}

#[test]
fn different_values_produce_different_signatures() {
    let a = json!({"cmd": "ls"});
    let b = json!({"cmd": "rm -rf /"});
    assert_ne!(input_signature(&a), input_signature(&b));
}

#[test]
fn nested_objects_canonicalised_recursively() {
    let a = json!({"outer": {"a": 1, "b": 2}});
    let b = json!({"outer": {"b": 2, "a": 1}});
    assert_eq!(input_signature(&a), input_signature(&b));
}

#[test]
fn arrays_preserve_order() {
    // Array order IS semantic — [1, 2] and [2, 1] are different lists.
    let a = json!([1, 2]);
    let b = json!([2, 1]);
    assert_ne!(input_signature(&a), input_signature(&b));
}

#[test]
fn signature_is_short_hex() {
    let s = input_signature(&json!({"x": 1}));
    assert_eq!(s.len(), 16);
    assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn empty_object_has_stable_signature() {
    let a = input_signature(&json!({}));
    let b = input_signature(&json!({}));
    assert_eq!(a, b);
}
