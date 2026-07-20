use foreign_press_reader_lib::{
    database::AndroidDatabase,
    mobile_portable::{self, MergeResult, PortableImportPreview},
    mobile_reading,
    platform_error::PlatformError,
    platform_paths::PlatformPaths,
};
use serde_json::json;
use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments.len() != 4 || arguments[0] != "roundtrip" {
        return Err("usage: portable-interop roundtrip <input> <output> <state-root>".into());
    }
    let input = Path::new(&arguments[1]);
    let output = Path::new(&arguments[2]);
    let state_root = Path::new(&arguments[3]);
    let paths = PlatformPaths::new(
        state_root.join("data"),
        state_root.join("cache"),
        state_root.join("logs"),
    );
    paths.prepare()?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut database = AndroidDatabase::open(&paths, "portable-interop")?;
    let (first_preview, first_merge) = import_once(&mut database, &paths, input)?;
    let (second_preview, second_merge) = import_once(&mut database, &paths, input)?;
    let exported = mobile_portable::export_archive(&database, &paths, output, "portable-interop")?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "first": report(&first_preview, &first_merge),
            "second": report(&second_preview, &second_merge),
            "exportedBytes": exported.bytes,
        }))?
    );
    Ok(())
}

fn import_once(
    database: &mut AndroidDatabase,
    paths: &PlatformPaths,
    archive: &Path,
) -> Result<(PortableImportPreview, MergeResult), PlatformError> {
    let token = uuid::Uuid::new_v4().to_string();
    let portable_root = paths.persistent_staging.join("portable");
    let token_root = portable_root.join(&token);
    fs::create_dir_all(&token_root).map_err(|_| PlatformError::storage_unavailable())?;
    let result = (|| {
        let inspected = mobile_portable::inspect_archive(
            database,
            archive,
            &token_root,
            &token,
            "interop.fprbackup",
        )?;
        let metadata = mobile_portable::staged_metadata(&portable_root, &token)?;
        let mut created = Vec::new();
        for package in &metadata.packages {
            let imported =
                mobile_portable::restore_staged_package(database, paths, &token_root, package)?;
            if !imported.duplicate {
                created.push(imported.publication.summary.id.clone());
                mobile_reading::clear_publication_lifecycle_for_restore(
                    database,
                    &imported.publication.summary.id,
                )?;
            }
        }
        match mobile_portable::merge_archive(database, archive) {
            Ok(merged) => Ok((inspected.preview, merged)),
            Err(error) => {
                for publication_id in created.iter().rev() {
                    let _ = mobile_reading::purge_imported_publication(
                        database,
                        &paths.data.join("library"),
                        publication_id,
                    );
                }
                Err(error)
            }
        }
    })();
    let _ = mobile_portable::discard(&portable_root, &token);
    result
}

fn report(preview: &PortableImportPreview, merged: &MergeResult) -> serde_json::Value {
    json!({
        "newPublications": preview.new_publication_count,
        "duplicatePublications": preview.duplicate_publication_count,
        "settings": merged.settings,
        "readingPositions": merged.reading_positions,
        "vocabulary": merged.vocabulary,
        "vocabularySources": merged.vocabulary_sources,
        "savedContexts": merged.saved_contexts,
        "studyPlans": merged.study_plans,
        "reviewCards": merged.review_cards,
        "reviewEvents": merged.review_events,
        "reinforcementEvents": merged.reinforcement_events,
        "reviewSuspensions": merged.review_suspensions,
    })
}
