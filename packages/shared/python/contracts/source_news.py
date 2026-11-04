"""Upstream source news event contracts (Python Pydantic v2)."""
from __future__ import annotations
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field


class SourceNewsEventType(str, Enum):
    NEWS_PUBLISHED = "NEWS_PUBLISHED"
    NEWS_UPDATED = "NEWS_UPDATED"
    NEWS_RETRACTED = "NEWS_RETRACTED"


class CmsOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    publisher_name: str = Field(..., min_length=1, max_length=128)
    channel_id: str = Field(..., min_length=1, max_length=64)
    author: Optional[str] = Field(None, max_length=128)
    editor: Optional[str] = Field(None, max_length=128)


class NewsParagraph(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paragraph_index: int = Field(..., ge=0)
    char_start: Optional[int] = Field(None, ge=0)
    char_end: Optional[int] = Field(None, ge=0)
    text: str
    paragraph_sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")


class NewsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(..., min_length=1, max_length=512)
    url: Optional[str] = None
    publish_time: str
    content_text: str = Field(..., min_length=1)
    content_sha256: str = Field(..., pattern=r"^[a-fA-F0-9]{64}$")
    paragraphs: List[NewsParagraph]
    copyright_notice: Optional[str] = None


class NewsRetractionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    retraction_time: str
    retraction_reason: str = Field(..., min_length=1, max_length=1024)
    replaced_by_doc_id: Optional[str] = Field(None, max_length=128)


class SourceNewsEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(..., pattern=r"^evt_[a-zA-Z0-9_-]{12,64}$")
    event_type: SourceNewsEventType
    event_time: str
    source_doc_id: str = Field(..., min_length=1, max_length=128)
    cms_origin: CmsOrigin
    news_payload: Optional[NewsPayload] = None
    retraction_payload: Optional[NewsRetractionPayload] = None
