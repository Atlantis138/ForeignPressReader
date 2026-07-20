use super::*;

#[tauri::command]
pub fn get_mobile_reader_vocabulary_state(
    state: tauri::State<'_, PlatformState>,
    request: DictionaryLookupRequest,
    lexeme_key: String,
) -> Result<mobile_vocabulary::ReaderVocabularyState, PlatformError> {
    let database = state.database()?;
    let context = mobile_vocabulary::verify_context(&database, &request)?;
    mobile_vocabulary::get_reader_state(&database, &context, &lexeme_key)
}

#[tauri::command]
pub fn set_mobile_vocabulary_favorite(
    state: tauri::State<'_, PlatformState>,
    request: DictionaryLookupRequest,
    lexeme_key: String,
    favorite: bool,
) -> Result<mobile_vocabulary::ReaderVocabularyState, PlatformError> {
    let detail = dictionary_query::get_lexeme(
        &dictionary_pack::installed_database_path(&state.paths),
        &lexeme_key,
    )?;
    let mut database = state.database()?;
    let context = mobile_vocabulary::verify_context(&database, &request)?;
    mobile_vocabulary::set_favorite(&mut database, &context, &detail, favorite)
}

#[tauri::command]
pub fn set_mobile_context_saved(
    state: tauri::State<'_, PlatformState>,
    request: DictionaryLookupRequest,
    lexeme_key: String,
    saved: bool,
) -> Result<mobile_vocabulary::ReaderVocabularyState, PlatformError> {
    let detail = dictionary_query::get_lexeme(
        &dictionary_pack::installed_database_path(&state.paths),
        &lexeme_key,
    )?;
    let mut database = state.database()?;
    let context = mobile_vocabulary::verify_context(&database, &request)?;
    mobile_vocabulary::set_context_saved(&mut database, &context, &detail, saved)
}

#[tauri::command]
pub fn list_mobile_vocabulary_favorites(
    state: tauri::State<'_, PlatformState>,
    query: VocabularyListQuery,
) -> Result<mobile_vocabulary::VocabularyListPage, PlatformError> {
    let database = state.database()?;
    mobile_vocabulary::list_favorites(&database, query)
}

#[tauri::command]
pub fn list_mobile_saved_contexts(
    state: tauri::State<'_, PlatformState>,
    lexeme_key: String,
    offset: Option<i64>,
) -> Result<mobile_vocabulary::SavedContextPage, PlatformError> {
    let database = state.database()?;
    mobile_vocabulary::list_contexts(&database, &lexeme_key, offset.unwrap_or(0))
}

#[tauri::command]
pub fn remove_mobile_vocabulary_favorite(
    state: tauri::State<'_, PlatformState>,
    lexeme_key: String,
) -> Result<(), PlatformError> {
    let mut database = state.database()?;
    mobile_vocabulary::remove_favorite(&mut database, &lexeme_key)
}
