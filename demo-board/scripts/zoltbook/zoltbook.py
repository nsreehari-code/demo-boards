"""
Zoltbook - Reasoning Surface Cache for Zoltbot

A read-through cache of Teams/Channels data with structural enrichment.
Agents read from Zoltbook; only Zoltbook writes (via Graph API fetches).

Key responsibilities:
- Cache messages locally (JSON files)
- Enrich messages with protocol metadata (is_ai_message, agent_name)
- Construct thread views for agents
- Post messages with consistent marker format

Cache is NOT a coordination mechanism - it's an optimization.
Each machine's Zoltbook may have different cache state.
Source of truth is always Teams (Graph API).
"""

import json
import re
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

# Cache TTL settings (seconds)
CHANNEL_CACHE_TTL = 30      # Skip channel refresh if synced within 30s
REPLY_CACHE_TTL = 60        # Skip reply fetch if synced within 60s


# Zoltbook cache location
ZOLTBOOK_DIR = Path.home() / ".zoltbot" / "zoltbook"

# AI message marker (injected by Zoltbook, detected on read)
# Teams preserves <i> tags and plain text, so we use: <i>::ai::</i>
AI_MARKER = '<i>::ai::</i>'

# Agent signature pattern: <i>::AgentName::</i>
# We inject: <b><i>::AgentName::</i></b>
# Teams preserves: <b><i>::AgentName::</i></b>
AGENT_SIGNATURE_PATTERN = re.compile(
    r'<i>::([^:]+)::</i>',
    re.IGNORECASE
)

# URL pattern for extracting links from message content
URL_PATTERN = re.compile(
    r'https?://[^\s<>"\']+',
    re.IGNORECASE
)


@dataclass
class Attachment:
    """An attachment on a message."""
    name: str
    content_type: str
    url: Optional[str]
    # For downloaded/cached attachments
    local_path: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Attachment':
        return cls(**data)


@dataclass
class EnrichedMessage:
    """A message with Zoltbook enrichments."""
    id: str
    sender: str                    # Display name (agent_name for AI, human name for user)
    sender_type: str               # "user" | "agent" | "system"
    content_text: str
    content_html: str
    created_at: str                # ISO timestamp
    posted_at: str                 # Human-readable posted date
    parent_id: Optional[str]       # None = root message
    
    # Teams 'from' field (who actually posted in Teams)
    teams_from: str                # The Teams account that posted
    
    # Zoltbook enrichments
    is_ai_message: bool
    agent_name: Optional[str]      # extracted from signature if AI message
    agent_icon: Optional[str]      # extracted from signature if AI message
    agent_owner: Optional[str]     # for AI messages: the human running the agent (teams_from)
    
    # Attachments and URLs
    attachments: List[Dict[str, Any]]  # List of attachment dicts
    urls: List[str]                    # URLs extracted from message content
    
    # Original data for debugging
    raw: Dict[str, Any]
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'EnrichedMessage':
        return cls(**data)


@dataclass 
class Thread:
    """A thread with root message and replies."""
    root: EnrichedMessage
    replies: List[EnrichedMessage]
    has_ai_reply: bool
    reply_count: int
    last_activity: str
    needs_follow_up: bool = False              # True if last reply is from user (needs response)
    last_user_reply: Optional[EnrichedMessage] = None  # The user reply needing response


class Zoltbook:
    """
    Reasoning Surface Cache.
    
    Provides read-through cache of Teams messages with enrichment.
    Agents read from here; writes go through Graph API with marker injection.
    """
    
    def __init__(self, graph_client=None):
        """
        Initialize Zoltbook.
        
        Args:
            graph_client: AzRestGraphClient instance (created on demand if None)
        """
        self._client = graph_client
        self._ensure_cache_dirs()
    
    def _ensure_cache_dirs(self):
        """Create cache directory structure."""
        ZOLTBOOK_DIR.mkdir(parents=True, exist_ok=True)
        (ZOLTBOOK_DIR / "teams").mkdir(exist_ok=True)
    
    @property
    def client(self):
        """Lazy-load Graph client."""
        if self._client is None:
            from .az_graph_client import AzRestGraphClient
            self._client = AzRestGraphClient()
        return self._client
    
    # =========================================================================
    # Registry Content Extraction
    # =========================================================================
    
    def extract_registry_content(self, html_content: str) -> str:
        """Extract file content from registry thread HTML, preserving indentation and line structure."""
        import html as html_mod
        text = html_content
        # If <pre> block exists, extract its content verbatim (Teams wraps code blocks in <pre>)
        pre_match = re.search(r'<pre[^>]*>(.*?)</pre>', text, re.DOTALL)
        if pre_match:
            text = pre_match.group(1)
        else:
            # Preserve line breaks
            text = re.sub(r'<br\s*/?>', '\n', text)
            text = re.sub(r'</p>', '\n', text)
            text = re.sub(r'</div>', '\n', text)
            # Strip remaining tags
            text = re.sub(r'<[^>]+>', '', text)
        # Decode HTML entities
        text = html_mod.unescape(text)
        # Remove trailing whitespace per line but preserve indentation
        lines = [line.rstrip() for line in text.split('\n')]
        # Strip leading/trailing blank lines
        while lines and not lines[0]:
            lines.pop(0)
        while lines and not lines[-1]:
            lines.pop()
        return '\n'.join(lines) + '\n' if lines else ''
    
    # =========================================================================
    # Message Enrichment (core protocol logic)
    # =========================================================================
    
    def _extract_text(self, html_content: str) -> str:
        """Extract plain text from HTML."""
        text = re.sub(r'<[^>]+>', '', html_content)
        text = text.replace('&nbsp;', ' ').replace('&amp;', '&')
        text = text.replace('&#10024;', '✨')
        return text.strip()
    
    def _detect_ai_message(self, content: str) -> bool:
        """
        Detect if message is from an AI agent.
        
        Detection: Look for <i>::ai::</i> marker.
        Teams preserves <i> tags and text content.
        """
        # Primary: exact marker
        if AI_MARKER in content:
            return True
        # Fallback: just the text pattern (in case <i> tag varies)
        if '::ai::' in content:
            return True
        return False
    
    def _extract_agent_signature(self, content: str) -> tuple[Optional[str], Optional[str]]:
        """
        Extract agent name from signature.
        
        Looks for: <i>::AgentName::</i> pattern
        
        Returns:
            (agent_name, agent_icon) or (None, None) if not found
        """
        match = AGENT_SIGNATURE_PATTERN.search(content)
        if match:
            name = match.group(1).strip()
            return name, "🤖"  # Default icon
        # Fallback: try text pattern without <i> tags
        fallback = re.search(r'::([^:]+)::', content)
        if fallback and fallback.group(1) != 'ai':  # Don't match ::ai::
            return fallback.group(1).strip(), "🤖"
        return None, None
    
    def _get_sender_info(self, message: Dict) -> tuple[str, str]:
        """
        Extract sender name and type.
        
        Returns:
            (sender_name, sender_type)
        """
        from_field = message.get("from")
        if not from_field:
            return "System", "system"
        
        user = from_field.get("user")
        if user:
            return user.get("displayName", "User"), "user"
        
        app = from_field.get("application")
        if app:
            return app.get("displayName", "Bot"), "system"
        
        return "Unknown", "user"
    
    def _should_skip_message(self, raw_message: Dict, channel_name: str = None) -> bool:
        """
        Determine if a message should be skipped (not processed by agents).
        
        Filters out:
        - System event messages (channel created, member added, etc.)
        - Messages from Teams channel connector bots (e.g., "<channel_name> Agent")
        - Messages from application/system sources
        
        Returns:
            True if message should be skipped, False otherwise
        """
        # Skip system event messages (messageType != "message")
        msg_type = raw_message.get("messageType", "message")
        if msg_type != "message":
            return True
        
        # Skip deleted messages
        if raw_message.get("deletedDateTime"):
            return True
        
        # Skip empty body messages (deleted or system)
        body = raw_message.get("body", {}) or {}
        body_content = body.get("content", "")
        if not body_content or body_content.strip() == "" or body_content.strip() == "<systemEventMessage/>":
            return True
        
        # Get sender info
        from_field = raw_message.get("from")
        if not from_field:
            # No sender = system message
            return True
        
        # Skip application/bot messages (not human users)
        app = from_field.get("application")
        if app:
            app_name = app.get("displayName", "")
            # Skip all application messages (channel connector bots, etc.)
            # These include "<ChannelName> Agent", "Workflows", etc.
            return True
        
        # Check if from a user but looks like a channel agent bot
        user = from_field.get("user")
        if user and channel_name:
            display_name = user.get("displayName", "")
            # Filter out "<channel_name> Agent" pattern
            if display_name.lower().endswith(" agent") and channel_name.lower() in display_name.lower():
                return True
        
        return False
    
    def enrich_message(self, raw_message: Dict, team_name: str = None, channel_name: str = None) -> EnrichedMessage:
        """
        Enrich a raw Graph API message with Zoltbook metadata.
        
        This is the core enrichment logic - called on every message fetch.
        
        For AI messages:
        - sender = agent_name (extracted from signature)
        - teams_from = the human account that runs the agent
        - agent_owner = teams_from
        
        For user messages:
        - sender = teams_from (the human name)
        - agent_owner = None
        """
        msg_id = raw_message.get("id", "")
        body = raw_message.get("body", {}) or {}
        content_html = body.get("content", "")
        content_text = self._extract_text(content_html)
        
        # Include subject/title for thread root messages
        subject = raw_message.get("subject")
        if subject:
            content_text = f"[Thread title: {subject}]\n{content_text}"
        
        # Get the actual Teams 'from' (who posted)
        teams_from, sender_type = self._get_sender_info(raw_message)
        
        # Parse created_at for human-readable format
        created_at = raw_message.get("createdDateTime", "")
        posted_at = self._format_posted_date(created_at)
        
        # Detect AI message
        is_ai = self._detect_ai_message(content_html)
        
        # Extract agent signature if AI message
        agent_name, agent_icon = None, None
        agent_owner = None
        
        if is_ai:
            agent_name, agent_icon = self._extract_agent_signature(content_html)
            if agent_name:
                sender_type = "agent"
                agent_owner = teams_from  # The human running the agent
        
        # Determine display sender
        # For AI messages: use agent_name (the agent identity)
        # For user messages: use teams_from (the human name)
        sender = agent_name if (is_ai and agent_name) else teams_from
        
        # Get parent ID for threading
        # Graph API uses replyToId for replies
        reply_to = raw_message.get("replyToId")
        
        # Extract attachments
        attachments = self._extract_attachments(raw_message, team_name=team_name, channel_name=channel_name)
        
        # Extract URLs from content
        urls = self._extract_urls(content_html)
        
        return EnrichedMessage(
            id=msg_id,
            sender=sender,
            sender_type=sender_type,
            content_text=content_text,
            content_html=content_html,
            created_at=created_at,
            posted_at=posted_at,
            parent_id=reply_to,
            teams_from=teams_from,
            is_ai_message=is_ai,
            agent_name=agent_name,
            agent_icon=agent_icon,
            agent_owner=agent_owner,
            attachments=attachments,
            urls=urls,
            raw=raw_message
        )
    
    def _extract_attachments(self, raw_message: Dict, team_name: str = None, channel_name: str = None) -> List[Dict[str, Any]]:
        """Extract attachment information from message and download to local cache."""
        attachments = raw_message.get("attachments", [])
        msg_id = raw_message.get("id", "")
        result = []
        for att in attachments:
            att_info = {
                "name": att.get("name", "unknown"),
                "content_type": att.get("contentType", ""),
                "url": None,
                "local_path": None,
                "extracted_text": None,
            }
            # Try to get download URL from contentUrl or other fields
            if "contentUrl" in att:
                att_info["url"] = att["contentUrl"]
            elif "content" in att and isinstance(att["content"], str):
                # Sometimes the URL is in the content field
                if att["content"].startswith("http"):
                    att_info["url"] = att["content"]
            
            # Download to local cache if URL available and team/channel known
            if att_info["url"] and team_name and channel_name and msg_id:
                try:
                    local_path, extracted = self._cache_attachment(
                        team_name, channel_name, msg_id, 
                        att_info["name"], att_info["url"]
                    )
                    if local_path:
                        att_info["local_path"] = str(local_path)
                    if extracted:
                        att_info["extracted_text"] = extracted
                except Exception as e:
                    import logging
                    logging.getLogger("zoltbook").warning(f"Failed to cache attachment {att_info['name']}: {e}")
            
            result.append(att_info)
        return result
    
    def _cache_attachment(self, team_name: str, channel_name: str, message_id: str,
                          filename: str, url: str) -> tuple:
        """
        Download attachment to local cache and extract text for supported formats.
        
        Returns:
            (local_path, extracted_text) — extracted_text is None for binary formats
        """
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        att_dir = msg_dir / "attachments"
        att_dir.mkdir(exist_ok=True)
        
        local_path = att_dir / filename
        
        # Skip if already cached
        if local_path.exists():
            extracted = self._extract_text_from_file(local_path)
            return local_path, extracted
        
        # Download via az rest (Graph API)
        try:
            # For SharePoint URLs, try to resolve and download
            if 'sharepoint.com' in url:
                from .az_graph_client import AzRestGraphClient
                client = AzRestGraphClient()
                # Try shares API for universal download
                import base64
                share_url = "u!" + base64.urlsafe_b64encode(url.encode()).decode().rstrip('=')
                try:
                    import subprocess
                    result = subprocess.run(
                        ["az.cmd", "rest", "--method", "GET",
                         "--url", f"https://graph.microsoft.com/v1.0/shares/{share_url}/driveItem/content",
                         "--output-file", str(local_path)],
                        capture_output=True, timeout=60
                    )
                    if result.returncode != 0:
                        return None, None
                except Exception:
                    return None, None
            else:
                # Direct URL download
                import urllib.request
                urllib.request.urlretrieve(url, str(local_path))
            
            if local_path.exists():
                extracted = self._extract_text_from_file(local_path)
                return local_path, extracted
            
            return None, None
            
        except Exception:
            return None, None
    
    def _extract_text_from_file(self, file_path: Path) -> str:
        """
        Extract text content from a file for supported text formats.
        Returns None for binary formats that need AI extraction.
        """
        suffix = file_path.suffix.lower()
        
        # Text-readable formats — extract directly
        text_formats = {'.md', '.txt', '.csv', '.yaml', '.yml', '.json', '.xml',
                        '.py', '.js', '.ts', '.java', '.html', '.css', '.sh', '.bat'}
        
        if suffix in text_formats:
            try:
                with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                    return f.read()
            except Exception:
                return None
        
        # Binary formats — return None (agents use ghcli for AI extraction when needed)
        # .docx, .pptx, .pdf, .xlsx, .png, .jpg, etc.
        return None
    
    def _extract_urls(self, content_html: str) -> List[str]:
        """Extract URLs from message content."""
        if not content_html:
            return []
        urls = URL_PATTERN.findall(content_html)
        # Deduplicate while preserving order
        seen = set()
        unique_urls = []
        for url in urls:
            # Clean up URL (remove trailing punctuation that got caught)
            url = url.rstrip('.,;:!?)')
            if url not in seen:
                seen.add(url)
                unique_urls.append(url)
        return unique_urls
    
    def _format_posted_date(self, iso_timestamp: str) -> str:
        """Convert ISO timestamp to human-readable format."""
        if not iso_timestamp:
            return ""
        try:
            dt = datetime.fromisoformat(iso_timestamp.replace('Z', '+00:00'))
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            return iso_timestamp
    
    # =========================================================================
    # Message Posting (with marker injection)
    # =========================================================================
    
    def format_agent_message(
        self,
        content: str,
        agent_name: str,
        agent_icon: str = "🤖",
        model: str = None
    ) -> str:
        """
        Format content for posting as agent message.
        
        Injects:
        - Agent signature: <b><i>::AgentName::</i></b>
        - AI marker: <i>::ai::</i>
        - Model marker (optional): <i>::model-name::</i>
        
        Uses <i>::text::</i> patterns that Teams preserves.
        
        This is the single source of truth for message format.
        """
        # Strip any existing markers (agent may have included them)
        clean_content = content.replace(AI_MARKER, "").replace('::ai::', "").strip()
        
        # Convert basic markdown to HTML
        html_content = self._markdown_to_html(clean_content)
        
        # Build model marker if provided (format: "provider:model" → "provider / model")
        if model:
            display_model = model
            model_marker = f' <i>::{display_model}::</i>'
        else:
            model_marker = ''
        
        # Full format with signature and marker
        # Uses <i>::text::</i> patterns that Teams preserves:
        # - <i>::AgentName::</i> for agent identification  
        # - <i>::ai::</i> for AI marker
        # - <i>::model::</i> for model (optional)
        return f'<b>{agent_icon}<i>::{agent_name}::</i></b><br/><br/>{html_content}<br/><br/><i>✨</i>{AI_MARKER}{model_marker}'
    
    def _markdown_to_html(self, text: str) -> str:
        """Convert basic Markdown to HTML for Teams."""
        # Bold: **text** or __text__
        text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
        text = re.sub(r'__(.+?)__', r'<b>\1</b>', text)
        
        # Italic: *text* or _text_ (but not inside words)
        text = re.sub(r'(?<!\w)\*([^*]+?)\*(?!\w)', r'<i>\1</i>', text)
        text = re.sub(r'(?<!\w)_([^_]+?)_(?!\w)', r'<i>\1</i>', text)
        
        # Inline code: `code`
        text = re.sub(r'`([^`]+?)`', r'<code>\1</code>', text)
        
        # Newlines to <br/>
        text = text.replace('\n', '<br/>')
        
        return text
    
    def post_message(
        self,
        team_id: str,
        channel_id: str,
        content: str,
        agent_name: str,
        agent_icon: str = "🤖",
        model: str = None
    ) -> Dict:
        """
        Post a new message to a channel.
        
        Automatically injects agent signature and AI marker.
        
        Returns:
            Posted message data from Graph API
        """
        formatted = self.format_agent_message(content, agent_name, agent_icon, model)
        result = self.client.post_channel_message(team_id, channel_id, formatted)
        
        # Do NOT cache posted messages — cache is read-through from Teams only.
        # The next get_threads refresh will pick up the posted message.
        
        return result
    
    def reply_to_message(
        self,
        team_id: str,
        channel_id: str,
        parent_message_id: str,
        content: str,
        agent_name: str,
        agent_icon: str = "🤖",
        model: str = None,
        subject: str = None
    ) -> Dict:
        """
        Reply to a message in a channel.
        
        Automatically injects agent signature and AI marker.
        
        Returns:
            Posted reply data from Graph API
        """
        formatted = self.format_agent_message(content, agent_name, agent_icon, model)
        result = self.client.reply_to_message(team_id, channel_id, parent_message_id, formatted, subject=subject)
        
        # Do NOT cache replies — cache is read-through from Teams only.
        # The next get_threads refresh will pick up the reply.
        
        return result
    
    # =========================================================================
    # Cache Operations (per-message directory structure)
    # =========================================================================
    #
    # Structure:
    #   teams/{team_name}/channels/{channel_name}/
    #     _meta.json                 # channel-level metadata
    #     messages/
    #       {message_id}/
    #         message.json           # enriched message content
    #         parent                  # parent id (empty for root)
    #         replies.json           # [{id, posted_at, is_ai}, ...]
    #         attachments/           # future: downloaded files
    #
    # =========================================================================
    
    def _get_team_dir(self, team_name: str, team_id: str = None) -> Path:
        """Get/create team cache directory. Uses team_id if available for uniqueness."""
        if team_id:
            safe_name = re.sub(r'[^\w-]', '', team_id)
        else:
            safe_name = re.sub(r'[^\w\s-]', '', team_name).strip().replace(' ', '_')
        team_dir = ZOLTBOOK_DIR / "teams" / safe_name
        team_dir.mkdir(parents=True, exist_ok=True)
        return team_dir
    
    def _get_channel_dir(self, team_name: str, channel_name: str, team_id: str = None, channel_id: str = None) -> Path:
        """Get/create channel cache directory. Uses channel_id if available for uniqueness."""
        if channel_id:
            safe_channel = re.sub(r'[^\w-]', '', channel_id)
        else:
            safe_channel = re.sub(r'[^\w\s-]', '', channel_name).strip().replace(' ', '_')
        channel_dir = self._get_team_dir(team_name, team_id) / "channels" / safe_channel
        channel_dir.mkdir(parents=True, exist_ok=True)
        (channel_dir / "messages").mkdir(exist_ok=True)
        return channel_dir
    
    def _get_message_dir(self, team_name: str, channel_name: str, message_id: str, team_id: str = None, channel_id: str = None) -> Path:
        """Get/create per-message directory."""
        channel_dir = self._get_channel_dir(team_name, channel_name, team_id, channel_id)
        msg_dir = channel_dir / "messages" / message_id
        msg_dir.mkdir(exist_ok=True)
        return msg_dir
    
    def _load_channel_meta(self, team_name: str, channel_name: str) -> Dict:
        """Load channel-level metadata."""
        meta_path = self._get_channel_dir(team_name, channel_name) / "_meta.json"
        if meta_path.exists():
            try:
                with open(meta_path, encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return {
            "team_name": team_name,
            "channel_name": channel_name,
            "last_sync": None,
            "team_id": None,
            "channel_id": None,
        }
    
    def _save_channel_meta(self, team_name: str, channel_name: str, meta: Dict):
        """Save channel-level metadata."""
        meta_path = self._get_channel_dir(team_name, channel_name) / "_meta.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    
    def _is_cache_fresh(self, last_sync: Optional[str], ttl_seconds: int) -> bool:
        """Check if cache is still fresh based on TTL."""
        if not last_sync:
            return False
        try:
            sync_time = datetime.fromisoformat(last_sync.replace('Z', '+00:00'))
            now = datetime.now(timezone.utc)
            age_seconds = (now - sync_time).total_seconds()
            return age_seconds < ttl_seconds
        except (ValueError, TypeError):
            return False
    
    def _load_replies_metadata(self, team_name: str, channel_name: str, message_id: str) -> List[Dict]:
        """
        Load reply metadata for a message.
        
        Returns list of dicts: [{id, posted_at, is_ai}, ...]
        """
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        replies_path = msg_dir / "replies.json"
        if replies_path.exists():
            try:
                with open(replies_path, encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return []
    
    def _save_replies_metadata(self, team_name: str, channel_name: str, message_id: str, replies: List[Dict]):
        """Save reply metadata for a message."""
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        replies_path = msg_dir / "replies.json"
        with open(replies_path, "w", encoding="utf-8") as f:
            json.dump(replies, f, indent=2)
    
    def _load_thread_meta(self, team_name: str, channel_name: str, message_id: str) -> Dict:
        """Load thread-level metadata (separate from replies list)."""
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        meta_path = msg_dir / "_thread_meta.json"
        if meta_path.exists():
            try:
                with open(meta_path, encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return {"last_replies_sync": None}
    
    def _save_thread_meta(self, team_name: str, channel_name: str, message_id: str, meta: Dict):
        """Save thread-level metadata."""
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        meta_path = msg_dir / "_thread_meta.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    
    def _add_reply_metadata(
        self,
        team_name: str,
        channel_name: str,
        parent_id: str,
        reply_id: str,
        posted_at: str,
        is_ai: bool
    ):
        """Add a reply's metadata to parent's replies.json."""
        replies = self._load_replies_metadata(team_name, channel_name, parent_id)
        
        # Check if already exists
        existing_ids = {r["id"] for r in replies}
        if reply_id in existing_ids:
            # Update existing entry
            for r in replies:
                if r["id"] == reply_id:
                    r["posted_at"] = posted_at
                    r["is_ai"] = is_ai
                    break
        else:
            # Add new entry
            replies.append({
                "id": reply_id,
                "posted_at": posted_at,
                "is_ai": is_ai
            })
        
        self._save_replies_metadata(team_name, channel_name, parent_id, replies)
    
    def _cache_message(
        self,
        team_id: str,
        channel_id: str,
        raw_message: Dict,
        parent_id: Optional[str] = None,
        team_name: str = None,
        channel_name: str = None
    ):
        """
        Cache a message to disk using per-message directory structure.
        
        Args:
            team_id: Team ID
            channel_id: Channel ID  
            raw_message: Raw Graph API message
            parent_id: Parent message ID (for replies)
            team_name: Team name (for directory)
            channel_name: Channel name (for directory)
        """
        if not team_name or not channel_name:
            return
        
        enriched = self.enrich_message(raw_message, team_name=team_name, channel_name=channel_name)
        msg_dir = self._get_message_dir(team_name, channel_name, enriched.id)
        
        # Save message.json
        msg_path = msg_dir / "message.json"
        with open(msg_path, "w", encoding="utf-8") as f:
            json.dump(enriched.to_dict(), f, indent=2)
        
        # Save parent file
        parent_path = msg_dir / "parent"
        with open(parent_path, "w", encoding="utf-8") as f:
            f.write(parent_id or "")
        
        # If this is a reply, update parent's replies.json
        if parent_id:
            self._add_reply_metadata(
                team_name, channel_name, parent_id,
                reply_id=enriched.id,
                posted_at=enriched.posted_at,
                is_ai=enriched.is_ai_message
            )
        else:
            # Root message - initialize empty replies.json if not exists
            replies_path = msg_dir / "replies.json"
            if not replies_path.exists():
                with open(replies_path, "w", encoding="utf-8") as f:
                    json.dump([], f)
    
    def _load_cached_message(self, team_name: str, channel_name: str, message_id: str) -> Optional[EnrichedMessage]:
        """Load a single message from cache, removing system messages if found."""
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        msg_path = msg_dir / "message.json"
        
        if msg_path.exists():
            try:
                with open(msg_path, encoding="utf-8") as f:
                    data = json.load(f)
                
                # Check if this is a system message that shouldn't have been cached
                sender_type = data.get("sender_type", "user")
                sender = data.get("sender", "")
                
                # Remove system messages and channel agent bots from cache
                if sender_type == "system" or (
                    sender.lower().endswith(" agent") and 
                    channel_name and 
                    channel_name.lower() in sender.lower()
                ):
                    # Clean up this cached message
                    try:
                        shutil.rmtree(msg_dir)
                    except (OSError, IOError):
                        pass
                    return None
                
                return EnrichedMessage.from_dict(data)
            except (json.JSONDecodeError, IOError, TypeError):
                pass
        return None
    
    def _list_cached_messages(self, team_name: str, channel_name: str) -> List[str]:
        """List all cached message IDs in a channel."""
        channel_dir = self._get_channel_dir(team_name, channel_name)
        messages_dir = channel_dir / "messages"
        
        if not messages_dir.exists():
            return []
        
        # Each subdirectory is a message ID
        return [d.name for d in messages_dir.iterdir() if d.is_dir()]
    
    def _is_root_message(self, team_name: str, channel_name: str, message_id: str) -> bool:
        """Check if a message is a root message (no parent)."""
        msg_dir = self._get_message_dir(team_name, channel_name, message_id)
        parent_path = msg_dir / "parent"
        
        if parent_path.exists():
            try:
                with open(parent_path, encoding="utf-8") as f:
                    parent_id = f.read().strip()
                return not parent_id  # Root if empty
            except IOError:
                pass
        return True  # Assume root if no parent file
    
    # =========================================================================
    # Thread Operations (agent-facing API)
    # =========================================================================
    
    def refresh_channel(
        self,
        team_name: str,
        team_id: str,
        channel_name: str,
        channel_id: str,
        top: int = 20,
        force: bool = False
    ) -> List[EnrichedMessage]:
        """
        Fetch latest messages from channel and update cache.
        
        Uses TTL-based caching: if synced within CHANNEL_CACHE_TTL seconds,
        returns cached data without API call (unless force=True).
        
        Returns:
            List of enriched messages
        """
        # Check if cache is fresh (TTL-based)
        meta = self._load_channel_meta(team_name, channel_name)
        if not force and self._is_cache_fresh(meta.get("last_sync"), CHANNEL_CACHE_TTL):
            # Return cached messages instead of API call
            message_ids = self._list_cached_messages(team_name, channel_name)
            cached = []
            for msg_id in message_ids:
                msg = self._load_cached_message(team_name, channel_name, msg_id)
                if msg and msg.parent_id is None:  # Root messages only
                    cached.append(msg)
            # Sort by created_at, newest first, limit to top
            cached.sort(key=lambda m: m.created_at, reverse=True)
            return cached[:top]
        
        raw_messages = self.client.get_channel_messages(team_id, channel_id, top=top)
        
        enriched = []
        for raw in raw_messages:
            # Skip system messages and channel bots
            if self._should_skip_message(raw, channel_name):
                continue
            
            msg = self.enrich_message(raw, team_name=team_name, channel_name=channel_name)
            enriched.append(msg)
            
            # Cache each message
            self._cache_message(
                team_id, channel_id, raw,
                team_name=team_name, channel_name=channel_name
            )
        
        # Update channel metadata
        meta = self._load_channel_meta(team_name, channel_name)
        meta["last_sync"] = datetime.now(timezone.utc).isoformat()
        meta["team_id"] = team_id
        meta["channel_id"] = channel_id
        self._save_channel_meta(team_name, channel_name, meta)
        
        return enriched
    
    def load_replies(
        self,
        team_name: str,
        team_id: str,
        channel_name: str,
        channel_id: str,
        message_id: str
    ) -> List[EnrichedMessage]:
        """
        Fetch replies for a message and update cache.
        
        Returns:
            List of enriched reply messages
        """
        raw_replies = self.client.get_message_replies(team_id, channel_id, message_id)
        
        enriched = []
        for raw in raw_replies:
            # Skip system messages and channel bots
            if self._should_skip_message(raw, channel_name):
                continue
            
            msg = self.enrich_message(raw, team_name=team_name, channel_name=channel_name)
            enriched.append(msg)
            
            # Cache each reply
            self._cache_message(
                team_id, channel_id, raw,
                parent_id=message_id,
                team_name=team_name, channel_name=channel_name
            )
        
        # Update thread metadata with sync timestamp
        thread_meta = self._load_thread_meta(team_name, channel_name, message_id)
        thread_meta["last_replies_sync"] = datetime.now(timezone.utc).isoformat()
        self._save_thread_meta(team_name, channel_name, message_id, thread_meta)
        
        return enriched
    
    def get_threads(
        self,
        team_name: str,
        team_id: str,
        channel_name: str,
        channel_id: str,
        unanswered_only: bool = False,
        refresh: bool = True,
        top: int = 20
    ) -> List[Thread]:
        """
        Get threads from a channel.
        
        Args:
            team_name: Team display name
            team_id: Team ID
            channel_name: Channel display name
            channel_id: Channel ID
            unanswered_only: Filter to threads without AI reply
            refresh: Fetch latest from API (vs cache-only)
            top: Max messages to fetch
        
        Returns:
            List of Thread objects
        """
        if refresh:
            messages = self.refresh_channel(team_name, team_id, channel_name, channel_id, top)
        else:
            # Load from cache - list all message directories
            message_ids = self._list_cached_messages(team_name, channel_name)
            messages = []
            for msg_id in message_ids:
                msg = self._load_cached_message(team_name, channel_name, msg_id)
                if msg:
                    messages.append(msg)
        
        # Build threads from root messages
        root_messages = [m for m in messages if m.parent_id is None]
        
        threads = []
        for root in root_messages:
            # Load replies metadata from message directory
            replies_meta = self._load_replies_metadata(team_name, channel_name, root.id)
            
            # Load reply messages from cache first
            replies = []
            for rmeta in replies_meta:
                reply = self._load_cached_message(team_name, channel_name, rmeta["id"])
                if reply:
                    replies.append(reply)
            
            # Smart reply fetching: only fetch if needed (not ALL threads)
            # Fetch replies only if:
            # 1. Never synced before
            # 2. Synced longer than REPLY_CACHE_TTL ago
            # 3. Thread has AI reply and might need follow-up detection
            should_fetch_replies = False
            if refresh:
                thread_meta = self._load_thread_meta(team_name, channel_name, root.id)
                last_sync = thread_meta.get("last_replies_sync")
                
                # Check cached state for quick has_ai determination
                has_ai_cached = root.is_ai_message or any(r.get("is_ai", False) for r in replies_meta)
                
                if not last_sync:
                    # Never synced - must fetch
                    should_fetch_replies = True
                elif not self._is_cache_fresh(last_sync, REPLY_CACHE_TTL):
                    # Cache expired - fetch threads with AI replies (need follow-up detection)
                    # Skip threads without AI reply (no follow-up possible)
                    should_fetch_replies = has_ai_cached or not replies_meta
                # If cache is fresh, use cached replies
            
            if should_fetch_replies:
                replies = self.load_replies(team_name, team_id, channel_name, channel_id, root.id)
                # Reload metadata after fetching (includes newly cached replies)
                replies_meta = self._load_replies_metadata(team_name, channel_name, root.id)
            
            # Determine if thread has AI reply (from metadata for efficiency)
            has_ai = root.is_ai_message or any(r.get("is_ai", False) for r in replies_meta)
            
            # Get last activity from replies metadata or root
            last_activity = root.created_at
            if replies_meta:
                # Get most recent reply's posted_at
                last_activity = max(r.get("posted_at", root.created_at) for r in replies_meta)
            
            # Detect follow-up needed: thread has AI reply but last reply is from user
            needs_follow_up = False
            last_user_reply = None
            if has_ai and replies:
                # Sort replies by created_at to find the most recent
                sorted_replies = sorted(replies, key=lambda r: r.created_at, reverse=True)
                last_reply = sorted_replies[0] if sorted_replies else None
                if last_reply and not last_reply.is_ai_message:
                    needs_follow_up = True
                    last_user_reply = last_reply
            
            thread = Thread(
                root=root,
                replies=replies,
                has_ai_reply=has_ai,
                reply_count=len(replies),
                last_activity=last_activity,
                needs_follow_up=needs_follow_up,
                last_user_reply=last_user_reply
            )
            
            # Apply filter
            if unanswered_only and has_ai:
                continue
            
            threads.append(thread)
        
        # Sort by created_at (oldest first for deterministic processing)
        threads.sort(key=lambda t: t.root.created_at)
        
        return threads
    
    def get_unanswered_threads(
        self,
        team_name: str,
        team_id: str,
        channel_name: str,
        channel_id: str,
        refresh: bool = True
    ) -> List[Thread]:
        """
        Get threads that don't have an AI reply yet.
        
        Convenience method for responder agents.
        """
        return self.get_threads(
            team_name, team_id, channel_name, channel_id,
            unanswered_only=True,
            refresh=refresh
        )
    
    # =========================================================================
    # Point Queries (blocking, fresh)
    # =========================================================================
    
    def get_thread_fresh(
        self,
        team_name: str,
        team_id: str,
        channel_name: str,
        channel_id: str,
        thread_id: str
    ) -> Optional[Thread]:
        """
        Get a specific thread with fresh replies from API.
        
        Use this before taking action on a thread - ensures you have
        the latest replies to avoid duplicate responses.
        
        Args:
            thread_id: Root message ID of the thread
            
        Returns:
            Thread with fresh replies, or None if not found
        """
        # Fetch fresh replies from API
        replies = self.load_replies(team_name, team_id, channel_name, channel_id, thread_id)
        
        # Load root message (from cache or fetch)
        root = self._load_cached_message(team_name, channel_name, thread_id)
        if not root:
            # Root not in cache, try fetching channel
            self.refresh_channel(team_name, team_id, channel_name, channel_id, top=50)
            root = self._load_cached_message(team_name, channel_name, thread_id)
            if not root:
                return None
        
        # Get updated metadata
        replies_meta = self._load_replies_metadata(team_name, channel_name, thread_id)
        has_ai = root.is_ai_message or any(r.get("is_ai", False) for r in replies_meta)
        
        last_activity = root.created_at
        if replies_meta:
            last_activity = max(r.get("posted_at", root.created_at) for r in replies_meta)
        
        # Detect follow-up needed: thread has AI reply but last reply is from user
        needs_follow_up = False
        last_user_reply = None
        if has_ai and replies:
            sorted_replies = sorted(replies, key=lambda r: r.created_at, reverse=True)
            last_reply = sorted_replies[0] if sorted_replies else None
            if last_reply and not last_reply.is_ai_message:
                needs_follow_up = True
                last_user_reply = last_reply
        
        return Thread(
            root=root,
            replies=replies,
            has_ai_reply=has_ai,
            reply_count=len(replies),
            last_activity=last_activity,
            needs_follow_up=needs_follow_up,
            last_user_reply=last_user_reply
        )
    
    # =========================================================================
    # Search Operations
    # =========================================================================
    
    def search_cache(
        self,
        team_name: str,
        channel_name: str,
        from_sender: Optional[str] = None,
        contains: Optional[str] = None,
        is_unanswered: bool = False,
        is_ai: Optional[bool] = None,
        limit: int = 50
    ) -> List[EnrichedMessage]:
        """
        Search cached messages with filters.
        
        This is instant (no API calls) but may return stale results.
        Use for discovery/prioritization, not action decisions.
        
        Args:
            from_sender: Filter by sender name (partial match)
            contains: Filter by content text (partial match)
            is_unanswered: Only root messages without AI replies
            is_ai: Filter by AI/human messages
            limit: Max results
            
        Returns:
            List of matching EnrichedMessage objects
        """
        message_ids = self._list_cached_messages(team_name, channel_name)
        results = []
        
        for msg_id in message_ids:
            if len(results) >= limit:
                break
                
            msg = self._load_cached_message(team_name, channel_name, msg_id)
            if not msg:
                continue
            
            # Apply filters
            if from_sender:
                if from_sender.lower() not in msg.sender.lower():
                    continue
            
            if contains:
                if contains.lower() not in msg.content_text.lower():
                    continue
            
            if is_ai is not None:
                if msg.is_ai_message != is_ai:
                    continue
            
            if is_unanswered:
                # Only root messages
                if msg.parent_id:
                    continue
                # Check if has AI reply
                replies_meta = self._load_replies_metadata(team_name, channel_name, msg.id)
                if any(r.get("is_ai", False) for r in replies_meta):
                    continue
            
            results.append(msg)
        
        return results
    
    def search_fresh(
        self,
        team_id: str,
        channel_id: str,
        query: str,
        team_name: str = None,
        channel_name: str = None,
        top: int = 20
    ) -> List[EnrichedMessage]:
        """
        Search via Graph API with a query string.
        
        The query is passed directly to Graph API $search.
        Examples:
            "from:Eric"
            "from:Ravi and from:Eric"
            "urgent deadline"
            "has:attachment"
        
        Args:
            query: Search query (passed to Graph API as-is)
            top: Max results
            
        Returns:
            List of EnrichedMessage objects matching the query
        """
        # Use Graph API search
        raw_messages = self.client.search_channel_messages(
            team_id, channel_id, query, top=top
        )
        
        enriched = []
        for raw in raw_messages:
            msg = self.enrich_message(raw)
            enriched.append(msg)
            
            # Cache results
            if team_name and channel_name:
                parent_id = raw.get("replyToId")
                self._cache_message(
                    team_id, channel_id, raw,
                    parent_id=parent_id,
                    team_name=team_name, channel_name=channel_name
                )
        
        return enriched
    
    def search(
        self,
        team_name: str,
        channel_name: str,
        query: str,
        team_id: str = None,
        channel_id: str = None,
        refresh: bool = False,
        is_unanswered: bool = True,
        limit: int = 50
    ) -> List[EnrichedMessage]:
        """
        Search messages with a query string.
        
        Query syntax (passed directly, parsed locally for cache search):
            "from:Eric"           - messages from sender containing "Eric"
            "contains:urgent"     - messages containing "urgent"
            "from:Eric urgent"    - combined filters
            
        Args:
            query: Search query string
            refresh: If True, use Graph API search (blocking); 
                    if False, search local cache (instant)
            is_unanswered: Only match root messages without AI replies
            limit: Max results
            
        Returns:
            List of matching EnrichedMessage objects
        """
        if refresh and team_id and channel_id:
            # Use Graph API search
            return self.search_fresh(
                team_id, channel_id, query,
                team_name=team_name, channel_name=channel_name,
                top=limit
            )
        
        # Parse query for cache search
        # Handle OR clauses: "contains:shipped OR contains:launched" -> match any
        from_sender = None
        contains_list = []  # Support multiple OR conditions
        remaining_terms = []
        
        for part in query.split():
            if part.upper() == "OR":
                continue  # Skip OR keyword
            elif part.lower().startswith("from:"):
                from_sender = part[5:]
            elif part.lower().startswith("contains:"):
                contains_list.append(part[9:])
            else:
                remaining_terms.append(part)
        
        # Use remaining terms as content search if no contains specified
        if remaining_terms and not contains_list:
            contains_list = [" ".join(remaining_terms)]
        
        # For single contains, use the standard search
        if len(contains_list) <= 1:
            contains = contains_list[0] if contains_list else None
            return self.search_cache(
                team_name, channel_name,
                from_sender=from_sender,
                contains=contains,
                is_unanswered=is_unanswered,
                limit=limit
            )
        
        # For multiple contains (OR logic), search for each and combine
        results = []
        seen_ids = set()
        for contains in contains_list:
            matches = self.search_cache(
                team_name, channel_name,
                from_sender=from_sender,
                contains=contains,
                is_unanswered=is_unanswered,
                limit=limit
            )
            for msg in matches:
                if msg.id not in seen_ids:
                    results.append(msg)
                    seen_ids.add(msg.id)
                    if len(results) >= limit:
                        return results
        return results
    
    # =========================================================================
    # Background Operations
    # =========================================================================
    
    def schedule_refresh(
        self,
        team_name: str,
        team_id: str,
        channel_name: str,
        channel_id: str,
        top: int = 20
    ):
        """
        Schedule a background refresh of channel messages.
        
        This is non-blocking - returns immediately.
        The refresh happens asynchronously.
        
        Use this to warm the cache while agent processes current work.
        """
        import threading
        
        def _do_refresh():
            try:
                self.refresh_channel(team_name, team_id, channel_name, channel_id, top)
            except Exception:
                pass  # Silently fail - it's just cache warming
        
        thread = threading.Thread(target=_do_refresh, daemon=True)
        thread.start()


# Singleton instance for shared access
_zoltbook_instance: Optional[Zoltbook] = None


def get_zoltbook() -> Zoltbook:
    """Get shared Zoltbook instance."""
    global _zoltbook_instance
    if _zoltbook_instance is None:
        _zoltbook_instance = Zoltbook()
    return _zoltbook_instance
