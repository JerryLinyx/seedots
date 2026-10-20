"""Cross-service contracts (tech plan §3, interface layer 1). Change these with care:
both services and stored data depend on them.

The foundation is domain-agnostic: it only knows media, time and evidence. Nothing here
mentions concepts, items or learners.
"""
from __future__ import annotations

import hashlib
import hmac
from typing import Any, Literal

from pydantic import BaseModel, Field

EvidenceKind = Literal["sentence", "chapter", "keyframe", "region"]
EvidenceSource = Literal["caption", "auto_caption", "asr", "vlm", "native_model", "llm_outline",
                         "platform_chapters", "heuristic", "user_correction"]
SourceKind = Literal["upload", "platform", "webpage"]
Visibility = Literal["public", "private"]
Playback = Literal["youtube_embed", "file"]


class Capabilities(BaseModel):
    """What the pipeline and the player can do with a media item. Decided at registration."""
    has_file: bool            # we hold the media file (frames, crops, ASR on our side)
    frames: bool              # frame images can be extracted -> keyframe / region evidence
    native_seek: bool         # player emits real seek events (YouTube embed does not)
    playback: Playback


class EvidenceRef(BaseModel):
    """How any other record points at evidence: always id + revision."""
    id: str
    revision: int = 1


class EvidenceUnit(BaseModel):
    id: str                   # "{media_id}.s0001" | ".c01" | ".k0001" | ".r0001"
    media_id: str
    revision: int = 1
    t0: float
    t1: float
    kind: EvidenceKind
    content: dict[str, Any]   # sentence {"text"}; chapter {"title","summary","sentence_ids"};
    #                           keyframe {"caption"?}; region {"text","label"}
    bbox: list[float] | None = None
    frame_ref: str | None = None
    source: EvidenceSource
    processor: str            # name@version
    confidence: float = 1.0
    needs_review: bool = False

    @property
    def short(self) -> str:
        """The id the model sees, e.g. s0042. Models cite these; code maps them back."""
        return self.id.rsplit(".", 1)[-1]

    @property
    def ref(self) -> EvidenceRef:
        return EvidenceRef(id=self.id, revision=self.revision)


EventType = Literal["media.registered", "media.outline_ready", "media.chapter_ready",
                    "media.evidence_revised", "media.analysis_completed", "media.failed"]


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
