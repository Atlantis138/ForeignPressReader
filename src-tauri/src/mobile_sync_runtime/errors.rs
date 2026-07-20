use super::*;

pub(super) type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Debug)]
pub(super) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(super) fn request_timeout(message: &str) -> Self {
        Self {
            status: StatusCode::REQUEST_TIMEOUT,
            message: message.into(),
        }
    }

    pub(super) fn bad(message: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    pub(super) fn conflict(message: &str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }
    pub(super) fn unauthorized(message: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }
    pub(super) fn not_found(message: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }
    pub(super) fn unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "跨设备同步暂时不可用。".into(),
        }
    }
    pub(super) fn insufficient_storage(message: &str) -> Self {
        Self {
            status: StatusCode::INSUFFICIENT_STORAGE,
            message: message.into(),
        }
    }
}

impl From<PlatformError> for ApiError {
    fn from(error: PlatformError) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

pub(super) fn sync_invalid(message: &'static str) -> PlatformError {
    PlatformError::new("syncInvalid", message, false)
}

pub(super) fn sync_busy(message: &'static str) -> PlatformError {
    PlatformError::new("syncBusy", message, false)
}

pub(super) fn sync_unavailable() -> PlatformError {
    PlatformError::new("syncUnavailable", "跨设备同步暂时不可用。", true)
}

pub(super) fn sync_network() -> PlatformError {
    PlatformError::new("syncNetwork", "无法连接局域网同步设备。", true)
}

pub(super) fn sync_identity_error() -> PlatformError {
    PlatformError::new("syncIdentity", "设备同步身份无法安全读取或保存。", false)
}

pub(super) fn sync_discovery_error() -> PlatformError {
    PlatformError::new(
        "localNetworkUnavailable",
        "局域网发现不可用；请检查 Wi-Fi、AP 隔离和本地网络权限。",
        true,
    )
}
