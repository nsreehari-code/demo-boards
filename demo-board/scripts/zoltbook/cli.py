#!/usr/bin/env python3
"""
Zoltbook CLI — Teams Graph API with enrichment.

Usage:
    python -m scripts.zoltbook.cli <action> [flags]
  or
    python scripts/zoltbook/cli.py <action> [flags]

Actions:
    list-teams
    list-channels       --team-id ID
    read-channel        --team-id ID --channel-id ID [--top N] [--team-name S] [--channel-name S]
    get-threads         --team-id ID --channel-id ID [--top N] [--team-name S] [--channel-name S]
                        [--unanswered-only]
    post-message        --team-id ID --channel-id ID --content TEXT
                        [--content-type html|text] [--subject S] [--agent-name S] [--agent-icon S]
    reply-to-message    --team-id ID --channel-id ID --message-id ID --content TEXT
                        [--content-type html|text] [--agent-name S] [--agent-icon S]
    search              --team-id ID --channel-id ID --query Q [--top N]
                        [--team-name S] [--channel-name S] [--refresh]
    set-reaction        --team-id ID --channel-id ID --message-id ID [--reaction-type like]
    remove-reaction     --team-id ID --channel-id ID --message-id ID [--reaction-type like]

All output is JSON to stdout.  Errors exit non-zero with message on stderr.
"""

import argparse
import json
import sys
import os
from dataclasses import asdict

# Allow running as `python scripts/zoltbook/cli.py` from demo-board dir
# by adding the parent of scripts/ to sys.path so the package import works.
_this_dir = os.path.dirname(os.path.abspath(__file__))
_scripts_dir = os.path.dirname(_this_dir)
_board_dir = os.path.dirname(_scripts_dir)
if _board_dir not in sys.path:
    sys.path.insert(0, _board_dir)

from scripts.zoltbook.zoltbook import Zoltbook, Thread, EnrichedMessage
from scripts.zoltbook.az_graph_client import AzRestGraphClient


def _thread_to_dict(t: Thread) -> dict:
    """Serialise a Thread to a plain dict."""
    d = {
        "root": asdict(t.root),
        "replies": [asdict(r) for r in t.replies],
        "has_ai_reply": t.has_ai_reply,
        "reply_count": t.reply_count,
        "last_activity": t.last_activity,
        "needs_follow_up": t.needs_follow_up,
    }
    if t.last_user_reply:
        d["last_user_reply"] = asdict(t.last_user_reply)
    return d


def _msg_to_dict(m: EnrichedMessage) -> dict:
    return asdict(m)


# ---------------------------------------------------------------------------
# Action handlers
# ---------------------------------------------------------------------------

def do_list_teams(args):
    client = AzRestGraphClient()
    teams = client.get_joined_teams()
    return teams


def do_list_channels(args):
    client = AzRestGraphClient()
    channels = client.get_team_channels(args.team_id)
    return channels


def do_read_channel(args):
    zb = Zoltbook()
    messages = zb.refresh_channel(
        team_name=args.team_name or args.team_id,
        team_id=args.team_id,
        channel_name=args.channel_name or args.channel_id,
        channel_id=args.channel_id,
        top=args.top,
        force=getattr(args, 'force', False),
    )
    return [_msg_to_dict(m) for m in messages]


def do_get_threads(args):
    zb = Zoltbook()
    threads = zb.get_threads(
        team_name=args.team_name or args.team_id,
        team_id=args.team_id,
        channel_name=args.channel_name or args.channel_id,
        channel_id=args.channel_id,
        unanswered_only=args.unanswered_only,
        refresh=True,
        top=args.top,
    )
    return [_thread_to_dict(t) for t in threads]


def do_post_message(args):
    zb = Zoltbook()
    if args.agent_name:
        result = zb.post_message(
            team_id=args.team_id,
            channel_id=args.channel_id,
            content=args.content,
            agent_name=args.agent_name,
            agent_icon=args.agent_icon,
        )
    else:
        client = AzRestGraphClient()
        result = client.post_channel_message(
            team_id=args.team_id,
            channel_id=args.channel_id,
            content=args.content,
            content_type=args.content_type,
            subject=args.subject,
        )
    return result


def do_reply_to_message(args):
    zb = Zoltbook()
    if args.agent_name:
        result = zb.reply_to_message(
            team_id=args.team_id,
            channel_id=args.channel_id,
            parent_message_id=args.message_id,
            content=args.content,
            agent_name=args.agent_name,
            agent_icon=args.agent_icon,
        )
    else:
        client = AzRestGraphClient()
        result = client.reply_to_message(
            team_id=args.team_id,
            channel_id=args.channel_id,
            message_id=args.message_id,
            content=args.content,
            content_type=args.content_type,
        )
    return result


def do_search(args):
    zb = Zoltbook()
    if args.refresh:
        results = zb.search_fresh(
            team_id=args.team_id,
            channel_id=args.channel_id,
            query=args.query,
            team_name=args.team_name,
            channel_name=args.channel_name,
            top=args.top,
        )
    else:
        results = zb.search(
            team_name=args.team_name or args.team_id,
            channel_name=args.channel_name or args.channel_id,
            query=args.query,
            team_id=args.team_id,
            channel_id=args.channel_id,
            refresh=False,
        )
    return [_msg_to_dict(m) for m in results]


def do_set_reaction(args):
    client = AzRestGraphClient()
    return client.set_reaction(
        team_id=args.team_id,
        channel_id=args.channel_id,
        message_id=args.message_id,
        reaction_type=args.reaction_type,
    )


def do_remove_reaction(args):
    client = AzRestGraphClient()
    return client.remove_reaction(
        team_id=args.team_id,
        channel_id=args.channel_id,
        message_id=args.message_id,
        reaction_type=args.reaction_type,
    )


# ---------------------------------------------------------------------------
# Argparse setup
# ---------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="zoltbook",
        description="Teams Graph API CLI with Zoltbook enrichment.",
    )
    sub = p.add_subparsers(dest="action", required=True)

    # -- list-teams --
    sub.add_parser("list-teams", help="List joined teams")

    # -- list-channels --
    lc = sub.add_parser("list-channels", help="List channels in a team")
    lc.add_argument("--team-id", required=True)

    # -- read-channel --
    rc = sub.add_parser("read-channel", help="Read enriched messages from a channel")
    rc.add_argument("--team-id", required=True)
    rc.add_argument("--channel-id", required=True)
    rc.add_argument("--team-name", default=None)
    rc.add_argument("--channel-name", default=None)
    rc.add_argument("--top", type=int, default=20)
    rc.add_argument("--force", action="store_true", help="Bypass cache TTL, always fetch from API")

    # -- get-threads --
    gt = sub.add_parser("get-threads", help="Get threads with enrichment")
    gt.add_argument("--team-id", required=True)
    gt.add_argument("--channel-id", required=True)
    gt.add_argument("--team-name", default=None)
    gt.add_argument("--channel-name", default=None)
    gt.add_argument("--top", type=int, default=20)
    gt.add_argument("--unanswered-only", action="store_true")

    # -- post-message --
    pm = sub.add_parser("post-message", help="Post a message to a channel")
    pm.add_argument("--team-id", required=True)
    pm.add_argument("--channel-id", required=True)
    pm.add_argument("--content", required=True)
    pm.add_argument("--content-type", default="html")
    pm.add_argument("--subject", default=None)
    pm.add_argument("--agent-name", default=None, help="If set, format as agent message with markers")
    pm.add_argument("--agent-icon", default="🤖")

    # -- reply-to-message --
    rm = sub.add_parser("reply-to-message", help="Reply to a message")
    rm.add_argument("--team-id", required=True)
    rm.add_argument("--channel-id", required=True)
    rm.add_argument("--message-id", required=True)
    rm.add_argument("--content", required=True)
    rm.add_argument("--content-type", default="html")
    rm.add_argument("--agent-name", default=None)
    rm.add_argument("--agent-icon", default="🤖")

    # -- search --
    se = sub.add_parser("search", help="Search messages (cache or Graph API)")
    se.add_argument("--team-id", required=True)
    se.add_argument("--channel-id", required=True)
    se.add_argument("--query", required=True)
    se.add_argument("--team-name", default=None)
    se.add_argument("--channel-name", default=None)
    se.add_argument("--top", type=int, default=25)
    se.add_argument("--refresh", action="store_true", help="Use Graph API instead of cache")

    # -- set-reaction --
    sr = sub.add_parser("set-reaction", help="Set a reaction on a message")
    sr.add_argument("--team-id", required=True)
    sr.add_argument("--channel-id", required=True)
    sr.add_argument("--message-id", required=True)
    sr.add_argument("--reaction-type", default="like",
                    choices=["like", "heart", "laugh", "surprised", "sad", "angry"])

    # -- remove-reaction --
    rr = sub.add_parser("remove-reaction", help="Remove a reaction from a message")
    rr.add_argument("--team-id", required=True)
    rr.add_argument("--channel-id", required=True)
    rr.add_argument("--message-id", required=True)
    rr.add_argument("--reaction-type", default="like",
                    choices=["like", "heart", "laugh", "surprised", "sad", "angry"])

    return p


DISPATCH = {
    "list-teams":        do_list_teams,
    "list-channels":     do_list_channels,
    "read-channel":      do_read_channel,
    "get-threads":       do_get_threads,
    "post-message":      do_post_message,
    "reply-to-message":  do_reply_to_message,
    "search":            do_search,
    "set-reaction":      do_set_reaction,
    "remove-reaction":   do_remove_reaction,
}


def main():
    parser = build_parser()
    args = parser.parse_args()

    handler = DISPATCH.get(args.action)
    if not handler:
        print(f"Unknown action: {args.action}", file=sys.stderr)
        sys.exit(1)

    try:
        result = handler(args)
        print(json.dumps(result, indent=2, default=str))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
