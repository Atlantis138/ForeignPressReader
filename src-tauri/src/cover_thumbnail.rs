use image::{codecs::jpeg::JpegEncoder, ImageReader};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

const CACHE_VERSION: &str = "v1";
const VARIANT: &str = "w384-q82";
const MAX_WIDTH: u32 = 384;
const MAX_HEIGHT: u32 = 512;
const JPEG_QUALITY: u8 = 82;
const MAX_CACHE_BYTES: u64 = 64 * 1024 * 1024;

static GENERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug)]
pub(crate) enum ThumbnailError {
    InvalidInput,
    Storage,
    Decode,
    LockPoisoned,
}

pub fn url(publication_id: &str, content_hash: &str) -> String {
    format!(
        "http://reader-asset.localhost/cover-thumbnail/{CACHE_VERSION}/{}/{content_hash}",
        utf8_percent_encode(publication_id, NON_ALPHANUMERIC)
    )
}

pub(crate) fn load_or_generate(
    cache_root: &Path,
    source: &Path,
    content_hash: &str,
) -> Result<Vec<u8>, ThumbnailError> {
    if !valid_hash(content_hash) || !source.is_file() {
        return Err(ThumbnailError::InvalidInput);
    }
    let destination = destination(cache_root, content_hash);
    if valid_cached_thumbnail(&destination) {
        return fs::read(destination).map_err(|_| ThumbnailError::Storage);
    }

    let lock = GENERATION_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().map_err(|_| ThumbnailError::LockPoisoned)?;
    if valid_cached_thumbnail(&destination) {
        return fs::read(destination).map_err(|_| ThumbnailError::Storage);
    }
    generate(source, &destination)?;
    prune(cache_root);
    fs::read(destination).map_err(|_| ThumbnailError::Storage)
}

fn destination(cache_root: &Path, content_hash: &str) -> PathBuf {
    cache_root
        .join("cover-thumbnails")
        .join(CACHE_VERSION)
        .join(format!("{content_hash}-{VARIANT}.jpg"))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_cached_thumbnail(path: &Path) -> bool {
    path.is_file()
        && fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0)
        && image::image_dimensions(path).is_ok_and(|(width, height)| {
            width > 0 && height > 0 && width <= MAX_WIDTH && height <= MAX_HEIGHT
        })
}

fn generate(source: &Path, destination: &Path) -> Result<(), ThumbnailError> {
    let image = ImageReader::open(source)
        .map_err(|_| ThumbnailError::Storage)?
        .with_guessed_format()
        .map_err(|_| ThumbnailError::Decode)?
        .decode()
        .map_err(|_| ThumbnailError::Decode)?
        .thumbnail(MAX_WIDTH, MAX_HEIGHT)
        .to_rgb8();
    let parent = destination.parent().ok_or(ThumbnailError::Storage)?;
    fs::create_dir_all(parent).map_err(|_| ThumbnailError::Storage)?;
    let temporary = parent.join(format!(
        ".{}-{}.tmp",
        destination
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or(ThumbnailError::Storage)?,
        std::process::id()
    ));
    let result = (|| {
        let file = File::create(&temporary).map_err(|_| ThumbnailError::Storage)?;
        let mut writer = BufWriter::new(file);
        JpegEncoder::new_with_quality(&mut writer, JPEG_QUALITY)
            .encode_image(&image)
            .map_err(|_| ThumbnailError::Decode)?;
        writer.flush().map_err(|_| ThumbnailError::Storage)?;
        drop(writer);
        if destination.exists() {
            fs::remove_file(destination).map_err(|_| ThumbnailError::Storage)?;
        }
        fs::rename(&temporary, destination).map_err(|_| ThumbnailError::Storage)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn prune(cache_root: &Path) {
    let root = cache_root.join("cover-thumbnails").join(CACHE_VERSION);
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, bytes, _)| *bytes).sum::<u64>();
    if total <= MAX_CACHE_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, bytes, _) in files {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};

    #[test]
    fn creates_a_bounded_regenerable_thumbnail() {
        let root = tempfile::tempdir().expect("root");
        let source = root.path().join("cover.png");
        DynamicImage::ImageRgb8(RgbImage::from_pixel(960, 1281, Rgb([32, 64, 96])))
            .save_with_format(&source, ImageFormat::Png)
            .expect("source");
        let hash = "a".repeat(64);

        let first = load_or_generate(root.path(), &source, &hash).expect("thumbnail");
        let cached = destination(root.path(), &hash);
        let (width, height) = image::image_dimensions(&cached).expect("dimensions");
        assert!(width <= MAX_WIDTH && height <= MAX_HEIGHT);
        assert!(first.len() < fs::metadata(&source).expect("source metadata").len() as usize);
        assert_eq!(
            first,
            load_or_generate(root.path(), &source, &hash).expect("cached")
        );
    }

    #[test]
    fn replaces_a_corrupt_cache_entry_and_rejects_unsafe_keys() {
        let root = tempfile::tempdir().expect("root");
        let source = root.path().join("cover.png");
        DynamicImage::ImageRgb8(RgbImage::from_pixel(120, 160, Rgb([10, 20, 30])))
            .save_with_format(&source, ImageFormat::Png)
            .expect("source");
        let hash = "b".repeat(64);
        load_or_generate(root.path(), &source, &hash).expect("thumbnail");
        fs::write(destination(root.path(), &hash), b"broken").expect("corrupt");

        let regenerated = load_or_generate(root.path(), &source, &hash).expect("regenerated");
        assert!(regenerated.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(load_or_generate(root.path(), &source, "../escape").is_err());
    }
}
