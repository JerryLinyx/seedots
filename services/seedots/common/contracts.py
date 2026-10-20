"""Cross-service contracts (tech plan §3, interface layer 1). Change these with care:
both services and stored data depend on them."""
from __future__ import annotations

import hashlib
import hmac
from typing import Any, Literal

from pydantic import BaseModel, Field

EvidenceKind = Literal["sentence", "keyframe", "region", "chapter"]
EvidenceSource = Literal["caption", "auto_caption", "asr", "vlm", "native_model", "llm_outline", "manual"]
SourceKind = Literal["upload", "platform", "webpage"]
Visibility = Literal["public", "private"]


class Capabilities(BaseModel):
    has_file: bool            # we hold the media file (can extract frames / crop)
    frames: bool              # frame images available for region evidence
    native_seek: bool         # player emits real seek events (YouTube embed does not)
    playback: Literal["youtube_embed", "file"]


class EvidenceUnit(BaseModel):
    id: str
    media_id: str
    revision: int = 1
    t0: float
    t1: float
    kind: EvidenceKind
    content: dict[str, Any]   # sentence: {"text"}; chapter: {"title","summary","sentence_ids"}
    bbox: list[float] | None = None
    frame_ref: str | None = None
    source: EvidenceSource
    processor: str            # name@version
    confidence: float = 1.0
    needs_review: bool = False


EventType = Literal["media.registered", "media.outline_ready", "media.chapter_ready", "media.failed"]


class MediaEvent(BaseModel):
    event_id: str
    type: EventType
    media_id: str
    seq: int = Field(description="per-media monotonically increasing sequence number")
    occurred_at: int          # epoch ms
    data: dict[str, Any] = Field(default_factory=dict)


SIGNATURE_HEADER = "X-SeeDots-Signature"


def sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def verify(body: bytes, secret: str, signature: str | None) -> bool:
    return bool(signature) and hmac.compare_digest(sign(body, secret), signature or "")
