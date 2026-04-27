"""
Graph API client using Azure CLI (az rest).

Uses your existing az login session - no app registration needed.
Simply calls Graph API via `az rest` command.
"""

import json
import subprocess
import shutil
import time
import os
import tempfile
from typing import Optional, Dict, Any, List
from pathlib import Path
from datetime import datetime
from contextlib import contextmanager

# Config file for saved channels
CHANNELS_CONFIG = Path.home() / ".zoltbot" / "channels_graph.json"
AZ_LOCK_FILE = Path.home() / ".zoltbot" / "az_cli.lock"


class GraphAPIError(Exception):
    """Raised when Graph API call fails."""
    pass


@contextmanager
def az_cli_lock(timeout: int = 120):
    """
    Simple file-based mutual exclusion for az CLI calls.
    
    Similar to copilot_wrapper.bat lock pattern - serializes az CLI calls
    across all zoltbot agents to prevent contention/timeouts.
    """
    lock_path = AZ_LOCK_FILE
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    
    start = time.time()
    lock_handle = None
    
    while True:
        try:
            # Try to open lock file exclusively (will fail if another process has it)
            lock_handle = open(lock_path, 'x')  # exclusive create
            lock_handle.write(f"{os.getpid()}:{time.time()}\n")
            lock_handle.flush()
            break
        except FileExistsError:
            # Lock exists - check if stale (older than 2 minutes)
            try:
                lock_age = time.time() - lock_path.stat().st_mtime
                if lock_age > 120:
                    lock_path.unlink(missing_ok=True)
                    continue
            except Exception:
                pass
            
            if time.time() - start > timeout:
                raise TimeoutError(f"Could not acquire az CLI lock after {timeout}s")
            time.sleep(0.3 + 0.2 * (hash(os.getpid()) % 5))  # Jittered backoff
    
    try:
        yield
    finally:
        if lock_handle:
            lock_handle.close()
        try:
            lock_path.unlink(missing_ok=True)
        except Exception:
            pass


class AzRestGraphClient:
    """
    Graph API client using `az rest` command.
    
    Uses your existing Azure CLI login - no separate auth needed.
    """
    
    def __init__(self):
        self._channels = self._load_channels()
        self._az_cmd = shutil.which("az") or shutil.which("az.cmd")
    
    def _load_channels(self) -> Dict[str, Dict]:
        """Load saved channels."""
        if CHANNELS_CONFIG.exists():
            try:
                with open(CHANNELS_CONFIG) as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return {}
    
    def _save_channels(self):
        """Save channels."""
        CHANNELS_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        with open(CHANNELS_CONFIG, "w") as f:
            json.dump(self._channels, f, indent=2)
    
    def _az_rest(self, method: str, url: str, body: Dict = None) -> Dict:
        """
        Call Graph API via az rest.
        
        Args:
            method: HTTP method (GET, POST, etc.)
            url: Full Graph API URL
            body: Request body (for POST/PATCH)
            
        Returns:
            JSON response
        """
        import tempfile
        
        if not self._az_cmd:
            raise RuntimeError("Azure CLI not found. Install from https://aka.ms/installazurecli")
        
        cmd = [self._az_cmd, "rest", "--method", method, "--url", url]
        
        temp_file = None
        try:
            if body:
                # Use temp file to avoid shell escaping issues on Windows
                fd, temp_file = tempfile.mkstemp(suffix=".json")
                with os.fdopen(fd, 'w', encoding='utf-8', errors='surrogatepass') as f:
                    json.dump(body, f, ensure_ascii=True)
                cmd.extend(["--body", f"@{temp_file}"])
            
            # No lock - az CLI can handle concurrent calls
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
            )
            
            if result.returncode != 0:
                error = result.stderr or result.stdout
                raise GraphAPIError(f"az rest failed: {error[:300]}")
            
            if result.stdout.strip():
                return json.loads(result.stdout)
            return {}
        finally:
            if temp_file and os.path.exists(temp_file):
                os.unlink(temp_file)
    
    # =========================================================================
    # Channel Management
    # =========================================================================
    
    def add_channel(self, name: str, team_id: str, channel_id: str):
        """Save a channel for quick access."""
        self._channels[name] = {
            "team_id": team_id,
            "channel_id": channel_id,
            "added_at": datetime.utcnow().isoformat(),
        }
        self._save_channels()
    
    def remove_channel(self, name: str) -> bool:
        """Remove a saved channel."""
        if name in self._channels:
            del self._channels[name]
            self._save_channels()
            return True
        return False
    
    def list_channels(self) -> List[Dict]:
        """List saved channels."""
        return [{"name": k, **v} for k, v in self._channels.items()]
    
    def get_channel(self, name: str) -> Optional[Dict]:
        """Get a saved channel."""
        return self._channels.get(name)
    
    # =========================================================================
    # Teams Operations
    # =========================================================================
    
    def get_me(self) -> Dict:
        """Get current user info."""
        return self._az_rest("GET", "https://graph.microsoft.com/v1.0/me")
    
    def get_joined_teams(self) -> List[Dict]:
        """Get teams the user has joined."""
        result = self._az_rest("GET", "https://graph.microsoft.com/v1.0/me/joinedTeams")
        return result.get("value", [])
    
    def get_team_channels(self, team_id: str) -> List[Dict]:
        """Get channels in a team."""
        result = self._az_rest("GET", f"https://graph.microsoft.com/v1.0/teams/{team_id}/channels")
        return result.get("value", [])
    
    def get_channel_messages(self, team_id: str, channel_id: str, top: int = 20, since: str = None) -> List[Dict]:
        """
        Get recent messages from a channel.
        
        Args:
            team_id: Team ID
            channel_id: Channel ID
            top: Maximum number of messages to return
            since: Optional ISO 8601 timestamp (e.g., '2026-02-12T21:00:00Z')
                   If provided, only returns messages created after this time
        
        Returns:
            List of message dicts
        """
        # Build base URL
        url = f"https://graph.microsoft.com/beta/teams/{team_id}/channels/{channel_id}/messages"
        
        # Build query parameters (use explicit quoting to avoid shell issues on Windows)
        params = [f"$top={top}"]
        if since:
            # URL-encode the filter value for Graph API
            from urllib.parse import quote
            filter_value = f"createdDateTime gt {since}"
            params.append(f"$filter={quote(filter_value, safe='')}")
        
        # Join params with & - the URL is passed as a single argument to subprocess
        # so shell interpretation shouldn't happen (but we avoid issues by proper encoding)
        url = url + "?" + "&".join(params)
        
        result = self._az_rest("GET", url)
        return result.get("value", [])
    
    def post_channel_message(
        self,
        team_id: str,
        channel_id: str,
        content: str,
        content_type: str = "html",
        attachments: List[Dict] = None,
        subject: str = None,
    ) -> Dict:
        """
        Post a message to a channel with optional attachments.
        
        Args:
            team_id: Team ID
            channel_id: Channel ID
            content: Message content (HTML or text)
            content_type: "html" or "text"
            subject: Optional thread subject/title
            attachments: List of attachment dicts with structure:
                [
                    {
                        "id": "unique-id",
                        "contentType": "reference",  # or "file"
                        "contentUrl": "https://...",  # for reference type
                        "content": "<base64>",  # for file type
                        "name": "filename.ext",
                        "thumbnailUrl": "https://..."  # optional
                    }
                ]
        """
        # Inject attachment markers into HTML content for all attachments
        if attachments and content_type == "html":
            attachment_markers = ""
            for att in attachments:
                attachment_markers += f'<attachment id="{att["id"]}"></attachment>'
            if attachment_markers:
                content = content + attachment_markers
        
        url = f"https://graph.microsoft.com/beta/teams/{team_id}/channels/{channel_id}/messages"
        body = {
            "body": {
                "contentType": content_type,
                "content": content,
            }
        }
        
        if subject:
            body["subject"] = subject
        
        if attachments:
            body["attachments"] = attachments
        
        return self._az_rest("POST", url, body)
    
    def get_message_replies(
        self,
        team_id: str,
        channel_id: str,
        message_id: str,
    ) -> List[Dict]:
        """
        Get all replies to a specific message.
        
        Args:
            team_id: Team ID
            channel_id: Channel ID
            message_id: Parent message ID
            
        Returns:
            List of reply message objects
        """
        url = f"https://graph.microsoft.com/beta/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies"
        try:
            result = self._az_rest("GET", url)
            return result.get("value", [])
        except GraphAPIError:
            # Message might not exist or no permission
            return []
    
    def search_channel_messages(
        self,
        team_id: str,
        channel_id: str,
        query: str,
        top: int = 20
    ) -> List[Dict]:
        """
        Search for messages in a channel using a query string.
        
        The query is passed directly to Graph API search.
        Examples:
            "from:Eric"
            "from:Ravi and from:Eric"
            "urgent deadline"
            "has:attachment"
        
        Args:
            team_id: Team ID
            channel_id: Channel ID
            query: Search query (passed to Graph API as-is)
            top: Maximum results
            
        Returns:
            List of message dicts matching the query
        """
        # Use Graph Search API with channel scope
        results = self.search_messages(
            query=query,
            team_id=team_id,
            channel_id=channel_id,
            top=top
        )
        return results
    
    def reply_to_message(
        self,
        team_id: str,
        channel_id: str,
        message_id: str,
        content: str,
        content_type: str = "html",
        attachments: List[Dict] = None,
        subject: str = None,
    ) -> Dict:
        """
        Reply to a message with optional attachments.
        
        Args:
            attachments: Same format as post_channel_message
            subject: Optional subject/title for the reply
        """
        # Inject attachment markers into HTML content for all attachments
        if attachments and content_type == "html":
            attachment_markers = ""
            for att in attachments:
                attachment_markers += f'<attachment id="{att["id"]}"></attachment>'
            if attachment_markers:
                content = content + attachment_markers
        
        url = f"https://graph.microsoft.com/beta/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies"
        body = {
            "body": {
                "contentType": content_type,
                "content": content,
            }
        }
        
        if attachments:
            body["attachments"] = attachments
        
        if subject:
            body["subject"] = subject
        
        return self._az_rest("POST", url, body)
    
    def set_reaction(
        self,
        team_id: str,
        channel_id: str,
        message_id: str,
        reaction_type: str = "like",
    ) -> Dict:
        """
        Set a reaction on a message.
        
        Args:
            reaction_type: One of: like, heart, laugh, surprised, sad, angry
            
        Note: This requires ChannelMessage.Send permission which may not be
        available via Azure CLI. Will raise ReactionNotSupported if permission denied.
        """
        url = f"https://graph.microsoft.com/beta/teams/{team_id}/channels/{channel_id}/messages/{message_id}/setReaction"
        body = {
            "reactionType": reaction_type
        }
        try:
            return self._az_rest("POST", url, body)
        except GraphAPIError as e:
            if "ChannelMessage.Send" in str(e) or "Missing scope" in str(e):
                raise ReactionNotSupported(
                    "Reactions require ChannelMessage.Send permission (admin consent needed). "
                    "Agent will continue without reactions."
                )
            raise
    
    def remove_reaction(
        self,
        team_id: str,
        channel_id: str,
        message_id: str,
        reaction_type: str = "like",
    ) -> Dict:
        """Remove a reaction from a message."""
        url = f"https://graph.microsoft.com/beta/teams/{team_id}/channels/{channel_id}/messages/{message_id}/unsetReaction"
        body = {
            "reactionType": reaction_type
        }
        try:
            return self._az_rest("POST", url, body)
        except GraphAPIError as e:
            if "ChannelMessage.Send" in str(e) or "Missing scope" in str(e):
                raise ReactionNotSupported("Reactions not available")
            raise
    
    # =========================================================================
    # Convenience Methods
    # =========================================================================
    
    def create_file_attachment(self, file_path: str, attachment_id: str = None) -> Dict:
        """
        Create an attachment dict for a local file (uploads as base64).
        
        Args:
            file_path: Path to local file
            attachment_id: Optional unique ID (auto-generated if not provided)
        
        Returns:
            Attachment dict ready for post_channel_message/reply_to_message
        """
        import base64
        import mimetypes
        from pathlib import Path
        
        file_path = Path(file_path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        # Read and encode file
        with open(file_path, 'rb') as f:
            content_bytes = f.read()
        content_base64 = base64.b64encode(content_bytes).decode('utf-8')
        
        # Determine MIME type
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"
        
        # Generate ID if not provided
        if not attachment_id:
            import uuid
            attachment_id = str(uuid.uuid4())
        
        return {
            "id": attachment_id,
            "contentType": "reference",  # Teams requires "reference" type
            "contentUrl": f"data:{mime_type};base64,{content_base64}",
            "name": file_path.name
        }
    
    def create_reference_attachment(
        self, 
        url: str, 
        name: str, 
        attachment_id: str = None,
        thumbnail_url: str = None
    ) -> Dict:
        """
        Create an attachment dict for a URL reference (e.g., SharePoint file).
        
        Args:
            url: URL to the file
            name: Display name for the attachment
            attachment_id: Optional unique ID (auto-generated if not provided)
            thumbnail_url: Optional thumbnail URL
        
        Returns:
            Attachment dict ready for post_channel_message/reply_to_message
        """
        import uuid
        
        if not attachment_id:
            attachment_id = str(uuid.uuid4())
        
        attachment = {
            "id": attachment_id,
            "contentType": "reference",
            "contentUrl": url,
            "name": name
        }
        
        if thumbnail_url:
            attachment["thumbnailUrl"] = thumbnail_url
        
        return attachment
    
    def search_messages(
        self, 
        query: str, 
        team_id: str = None,
        channel_id: str = None,
        top: int = 25
    ) -> List[Dict]:
        """
        Search for messages using Graph Search API.
        
        Args:
            query: Search query (e.g., "protocol:message_identification")
            team_id: Optional - limit to specific team
            channel_id: Optional - limit to specific channel (requires team_id)
            top: Maximum results to return (default: 25)
            
        Returns:
            List of matching messages with hits and details
        """
        # Build search request
        search_body = {
            "requests": [
                {
                    "entityTypes": ["chatMessage"],
                    "query": {
                        "queryString": query
                    },
                    "size": top
                }
            ]
        }
        
        # Add filters if specified
        if team_id or channel_id:
            filters = []
            if team_id:
                filters.append(f"teamId:{team_id}")
            if channel_id:
                filters.append(f"channelId:{channel_id}")
            
            if filters:
                search_body["requests"][0]["query"]["filters"] = {
                    "and": [{"property": f, "value": ""} for f in filters]
                }
        
        url = "https://graph.microsoft.com/v1.0/search/query"
        try:
            result = self._az_rest("POST", url, search_body)
            
            # Extract hits from response
            hits = []
            for response in result.get("value", []):
                hitsContainer = response.get("hitsContainers", [])
                for container in hitsContainer:
                    hits.extend(container.get("hits", []))
            
            return hits
        except GraphAPIError as e:
            # Search might not be available or query syntax error
            return []
    
    def upload_file_to_channel(self, team_id: str, channel_id: str, file_path: str) -> Dict:
        """
        Upload a file to a Teams channel's Files folder.
        
        Args:
            team_id: Team ID
            channel_id: Channel ID
            file_path: Path to local file to upload
        
        Returns:
            Dict with 'webUrl' (sharing link) and 'id' (drive item ID)
        """
        from pathlib import Path
        
        file_path = Path(file_path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        # Step 1: Get the channel's files folder
        files_folder_url = f"https://graph.microsoft.com/v1.0/teams/{team_id}/channels/{channel_id}/filesFolder"
        files_folder = self._az_rest("GET", files_folder_url)
        
        # Extract drive info from parentReference
        parent_ref = files_folder.get("parentReference", {})
        drive_id = parent_ref.get("driveId")
        folder_id = files_folder.get("id")
        
        if not drive_id or not folder_id:
            raise GraphAPIError("Could not determine drive location for channel files")
        
        # Step 2: Upload the file
        file_name = file_path.name
        upload_url = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{folder_id}:/{file_name}:/content"
        
        # Read file content
        with open(file_path, 'rb') as f:
            file_content = f.read()
        
        # Use az rest with binary content - write to temp file for body
        import tempfile
        with tempfile.NamedTemporaryFile(mode='wb', delete=False, suffix='.bin') as temp_file:
            temp_file.write(file_content)
            temp_path = temp_file.name
        
        try:
            # Upload file
            import subprocess
            cmd = [
                "az.cmd", "rest",
                "--method", "PUT",
                "--url", upload_url,
                "--body", f"@{temp_path}",
                "--headers", "Content-Type=application/octet-stream"
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                raise GraphAPIError(f"File upload failed: {result.stderr}")
            
            import json
            upload_result = json.loads(result.stdout)
            
            # Step 3: Create a sharing link
            item_id = upload_result.get("id")
            share_url = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{item_id}/createLink"
            share_body = {
                "type": "view",
                "scope": "organization"
            }
            
            share_result = self._az_rest("POST", share_url, share_body)
            
            return {
                "webUrl": share_result.get("link", {}).get("webUrl"),
                "id": item_id,
                "driveId": drive_id,
                "name": file_name
            }
            
        finally:
            # Clean up temp file
            import os
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    
    def get_sharepoint_file(self, site_id: str, file_path: str) -> bytes:
        """
        Get file content from SharePoint.
        
        Args:
            site_id: SharePoint site ID
            file_path: Path relative to site root (e.g., "protocols/stable/message_identification.yaml")
        
        Returns:
            File content as bytes
        """
        url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root:/{file_path}:/content"
        
        # For binary downloads, use az rest directly and capture bytes
        import subprocess
        cmd = [
            "az.cmd", "rest",
            "--method", "GET",
            "--url", url
        ]
        
        result = subprocess.run(cmd, capture_output=True)
        
        if result.returncode != 0:
            raise GraphAPIError(f"SharePoint file download failed: {result.stderr.decode('utf-8', errors='replace')}")
        
        return result.stdout
    
    def upload_sharepoint_file(self, site_id: str, file_path: str, content: bytes, content_type: str = None) -> Dict:
        """
        Upload file to SharePoint.
        
        Args:
            site_id: SharePoint site ID
            file_path: Path relative to site root (e.g., "protocols/stable/message_identification.yaml")
            content: File content as bytes
            content_type: MIME type (optional, auto-detected if not provided)
        
        Returns:
            Upload result with file metadata
        """
        import tempfile
        import mimetypes
        
        # Determine content type if not provided
        if not content_type:
            content_type, _ = mimetypes.guess_type(file_path)
            if not content_type:
                content_type = "application/octet-stream"
        
        # Write content to temp file
        with tempfile.NamedTemporaryFile(mode='wb', delete=False, suffix='.bin') as temp_file:
            temp_file.write(content)
            temp_path = temp_file.name
        
        try:
            url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root:/{file_path}:/content"
            
            import subprocess
            cmd = [
                "az.cmd", "rest",
                "--method", "PUT",
                "--url", url,
                "--body", f"@{temp_path}",
                "--headers", f"Content-Type={content_type}"
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                raise GraphAPIError(f"SharePoint upload failed: {result.stderr}")
            
            import json
            return json.loads(result.stdout)
            
        finally:
            import os
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    
    def list_sharepoint_folder(self, site_id: str, folder_path: str) -> List[Dict]:
        """
        List files in a SharePoint folder.
        
        Args:
            site_id: SharePoint site ID
            folder_path: Folder path relative to site root (e.g., "protocols/stable")
        
        Returns:
            List of file/folder items
        """
        url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root:/{folder_path}:/children"
        
        try:
            result = self._az_rest("GET", url)
            return result.get("value", [])
        except GraphAPIError:
            # Folder might not exist
            return []
    
    def post_to_saved_channel(self, channel_name: str, content: str, content_type: str = "html") -> Dict:
        """Post to a saved channel by name."""
        ch = self.get_channel(channel_name)
        if not ch:
            raise ValueError(f"Channel '{channel_name}' not found. Use 'zoltbot save-channel' first.")
        
        return self.post_channel_message(ch["team_id"], ch["channel_id"], content, content_type)
    
    def get_messages_from_saved_channel(self, channel_name: str, top: int = 20) -> List[Dict]:
        """Get messages from a saved channel."""
        ch = self.get_channel(channel_name)
        if not ch:
            raise ValueError(f"Channel '{channel_name}' not found.")
        
        return self.get_channel_messages(ch["team_id"], ch["channel_id"], top)


# GraphAPIError already defined at top of file


class ReactionNotSupported(GraphAPIError):
    """Raised when reactions fail due to missing permissions (non-fatal)."""
    pass
