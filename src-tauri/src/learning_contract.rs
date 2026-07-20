use crate::platform_error::PlatformError;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub const MOBILE_STUDY_ENGINE_VERSION: &str = "fsrs-6/ts-fsrs-5.4.1/mobile-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredReviewCardContract {
    pub due_at: String,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub learning_steps: i64,
    pub reps: i64,
    pub lapses: i64,
    pub state: i64,
    pub last_review_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileReviewTransitionProposal {
    pub contract_version: u32,
    pub engine_version: String,
    pub expected_version: i64,
    pub command_id: String,
    pub answer: String,
    pub reviewed_at: String,
    pub before_fingerprint: String,
    pub parameters_fingerprint: String,
    pub before: StoredReviewCardContract,
    pub after: StoredReviewCardContract,
    pub rating: i64,
    pub log: serde_json::Value,
}

pub fn normalize_lemma(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .replace(['‘', '’'], "'")
        .trim()
        .into()
}

pub fn create_lexeme_key(language: &str, lemma: &str) -> String {
    let language = language.trim().to_lowercase();
    let language = if language.is_empty() {
        "und"
    } else {
        &language
    };
    let digest = Sha256::digest(format!("{language}\u{1f}{}", normalize_lemma(lemma)).as_bytes());
    format!("lex_{language}_{}", &hex::encode(digest)[..24])
}

pub fn review_card_fingerprint(card: &StoredReviewCardContract) -> Result<String, PlatformError> {
    validate_card(card)?;
    Ok(sha256_hex(
        [
            "review-card-v1".into(),
            card.due_at.clone(),
            format!("{:016x}", card.stability.to_bits()),
            format!("{:016x}", card.difficulty.to_bits()),
            card.elapsed_days.to_string(),
            card.scheduled_days.to_string(),
            card.learning_steps.to_string(),
            card.reps.to_string(),
            card.lapses.to_string(),
            card.state.to_string(),
            card.last_review_at.clone().unwrap_or_default(),
        ]
        .join("\u{1f}")
        .as_bytes(),
    ))
}

pub fn validate_review_proposal(
    proposal: &MobileReviewTransitionProposal,
    expected_before: &StoredReviewCardContract,
    expected_version: i64,
    command_id: &str,
) -> Result<(), PlatformError> {
    if proposal.contract_version != 1
        || proposal.engine_version != MOBILE_STUDY_ENGINE_VERSION
        || proposal.expected_version != expected_version
        || proposal.command_id != command_id
        || proposal.before != *expected_before
        || proposal.before_fingerprint != review_card_fingerprint(expected_before)?
        || !is_hash(&proposal.parameters_fingerprint)
        || DateTime::parse_from_rfc3339(&proposal.reviewed_at).is_err()
        || !matches!(
            (proposal.answer.as_str(), proposal.rating),
            ("known", 3) | ("unknown", 1)
        )
        || !proposal.log.is_object()
    {
        return Err(invalid_proposal());
    }
    validate_card(&proposal.after)?;
    if proposal.after.reps < proposal.before.reps
        || proposal.after.lapses < proposal.before.lapses
        || proposal.after.scheduled_days < 0
    {
        return Err(invalid_proposal());
    }
    Ok(())
}

fn validate_card(card: &StoredReviewCardContract) -> Result<(), PlatformError> {
    if DateTime::parse_from_rfc3339(&card.due_at).is_err()
        || card
            .last_review_at
            .as_deref()
            .is_some_and(|value| DateTime::parse_from_rfc3339(value).is_err())
        || !card.stability.is_finite()
        || !card.difficulty.is_finite()
        || card.stability < 0.0
        || card.difficulty < 0.0
        || card.elapsed_days < 0
        || card.scheduled_days < 0
        || card.learning_steps < 0
        || card.reps < 0
        || card.lapses < 0
        || !(0..=3).contains(&card.state)
    {
        return Err(invalid_proposal());
    }
    Ok(())
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn invalid_proposal() -> PlatformError {
    PlatformError::new("invalidLearningProposal", "学习状态转换提案无效。", false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexeme_keys_match_the_published_typescript_semantics() {
        assert_eq!(
            create_lexeme_key("EN", "  RUN  "),
            "lex_en_bef0f93b22ad080a29e3aa86"
        );
        assert_eq!(normalize_lemma("’Saw’"), "'saw'");
    }

    #[test]
    fn validates_the_shared_d0_learning_vector() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/d0-learning.json"))
                .expect("vector");
        for entry in vector["dictionary"]["entries"].as_array().expect("entries") {
            assert_eq!(
                create_lexeme_key("en", entry["lemma"].as_str().expect("lemma")),
                entry["lexemeKey"].as_str().expect("key")
            );
        }
        let proposal: MobileReviewTransitionProposal =
            serde_json::from_value(vector["study"]["reviewProposal"].clone())
                .expect("review proposal");
        validate_review_proposal(
            &proposal,
            &proposal.before,
            vector["study"]["expectedVersion"]
                .as_i64()
                .expect("version"),
            vector["study"]["commandId"].as_str().expect("command"),
        )
        .expect("valid review proposal");
    }

    #[test]
    fn rejects_tampered_learning_proposals() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("../../test-vectors/d0-learning.json"))
                .expect("vector");
        let mut proposal: MobileReviewTransitionProposal =
            serde_json::from_value(vector["study"]["reviewProposal"].clone()).expect("proposal");
        proposal.after.reps = -1;
        assert_eq!(
            validate_review_proposal(&proposal, &proposal.before, 3, &proposal.command_id)
                .expect_err("reject")
                .code,
            "invalidLearningProposal"
        );
    }
}
