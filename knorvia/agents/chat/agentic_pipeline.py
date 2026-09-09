"""Chat capability assembly for the exploring-loop agent."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from knorvia.agents._shared.tool_composition import (
    ToolMountFlags,
    compose_enabled_tools,
    default_optional_tools,
    user_has_memory,
    user_has_notebooks,
)
from knorvia.agents.chat.prompt_blocks import ChatPromptAssembler
from knorvia.capabilities import (
    LoopCapability,
    PromptBlock,
    active_loop_capabilities,
    any_exclusive_capability_active,
)
from knorvia.core.agentic import (
    DispatchOutcome,
    UsageTracker,
    can_use_native_tool_calling,
    dispatch_tool_calls,
)
from knorvia.core.agentic.tool_dispatch import MAX_PARALLEL_TOOL_CALLS
from knorvia.core.context import UnifiedContext
from knorvia.core.tool_protocol import ToolLookup
from knorvia.core.trace import (
    build_trace_metadata,
    derive_trace_metadata,
    merge_trace_metadata,
    new_call_id,
)
from knorvia.knowledge.manifest import KbManifest, render_manifest_note
from knorvia.runtime.providers import ToolScope
from knorvia.runtime.providers.view import ProviderToolView, build_tool_view
from knorvia.runtime.registry.deferred_tools import DeferredToolLoader
from knorvia.runtime.registry.tool_registry import get_tool_registry
from knorvia.services.cli_apps.models import TOOL_PREFIX as CLI_APP_TOOL_PREFIX
from knorvia.services.config import get_chat_params
from knorvia.services.llm import (
    get_llm_config,
    prepare_multimodal_messages,
)
from knorvia.services.llm.context_window import resolve_effective_context_window
from knorvia.services.prompt import get_prompt_manager
from knorvia.tools.builtin import PARTNER_BUILTIN_TOOL_NAMES

logger = logging.getLogger(__name__)

# Chat memory tools a partner turn replaces with the partner_* variants.
_PARTNER_SUPPRESSED_TOOLS: tuple[str, ...] = ("read_memory", "write_memory")

# Tools whose server-side caller identity gets stamped into the call kwargs
# on a partner turn ("send, don't wait" DM + roster management).
_SENDER_STAMPED_PARTNER_TOOLS: tuple[str, ...] = (
    "send_partner_message",
    "create_partner",
    "update_partner",
)


CHAT_EXCLUDED_TOOLS: set[str] = set()
CHAT_OPTIONAL_TOOLS = default_optional_tools(excluded=CHAT_EXCLUDED_TOOLS)

# Generation tools are user-toggleable + grant-gated, but only usable once an
# admin has configured an active model for the service. Drop them from a turn's
# tool list when unconfigured so the model never sees a tool that can only error.
_GENERATION_TOOL_SERVICES: dict[str, str] = {"imagegen": "imagegen", "videogen": "videogen"}

# Office artifact runtime v2 tools. All of them run on server-injected context
# (task dir, session, attachment manifest, frozen selection); the model never
# names paths or drafts itself.
_OFFICE_TOOL_NAMES: frozenset[str] = frozenset(
    {"office_document", "office_artifact", "office_read", "office_apply"}
)
_OFFICE_ATTACHMENT_SUFFIXES: tuple[str, ...] = (".xlsx", ".xlsm", ".docx", ".pptx")


def _office_attachment_manifest(context: UnifiedContext) -> list[dict[str, str]]:
    """Office-relevant subset of the turn's chat attachments.

    Only a loose suffix filter here — ``resolve_source`` re-validates MIME
    strictly when an attachment ref is actually opened.
    """
    manifest: list[dict[str, str]] = []
    for att in context.attachments or []:
        filename = str(getattr(att, "filename", "") or "")
        if not filename.lower().endswith(_OFFICE_ATTACHMENT_SUFFIXES):
            continue
        manifest.append(
            {
                "id": str(getattr(att, "id", "") or ""),
                "filename": filename,
                "mime": str(getattr(att, "mime_type", "") or ""),
            }
        )
    return manifest


def _drop_unconfigured_generation_tools(tools: list[str]) -> list[str]:
    present = [name for name in tools if name in _GENERATION_TOOL_SERVICES]
    if not present:
        return tools
    configured: set[str] = set()
    try:
        from knorvia.services.config.model_catalog import get_model_catalog_service

        service = get_model_catalog_service()
        catalog = service.load()
        for name in present:
            if name == "imagegen":
                from knorvia.multi_user.model_access import allowed_imagegen_options

                if allowed_imagegen_options().get("options"):
                    configured.add(name)
                continue
            if name == "videogen":
                from knorvia.multi_user.model_access import allowed_videogen_options

                if allowed_videogen_options().get("options"):
                    configured.add(name)
                continue
            if (service.get_active_model(catalog, _GENERATION_TOOL_SERVICES[name]) or {}).get(
                "model"
            ):
                configured.add(name)
    except Exception:
        logger.debug("generation-tool config probe failed; dropping them", exc_info=True)
    return [name for name in tools if name not in _GENERATION_TOOL_SERVICES or name in configured]


KB_SEED_MAX_KBS = 3
KB_SEED_CHARS_PER_KB = 4000
# Exploring-loop budget: max LLM rounds in one turn's loop. A round without
# tool calls ends the loop early — that is the normal exit.
DEFAULT_MAX_ROUNDS = 8
CONTEXT_WINDOW_GUARD_RATIO = 0.9
_DispatchOutcome = DispatchOutcome


def _read_int(cfg: Any, *, key: str, default: int) -> int:
    if isinstance(cfg, dict):
        value = cfg.get(key, default)
    else:
        value = default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalise_user_reply(raw: Any) -> tuple[str, list[dict[str, str]] | None]:
    if isinstance(raw, str):
        return raw, None
    if isinstance(raw, dict):
        text = str(raw.get("text") or "")
        answers_raw = raw.get("answers")
        if isinstance(answers_raw, list) and answers_raw:
            answers: list[dict[str, str]] = []
            for entry in answers_raw:
                if not isinstance(entry, dict):
                    continue
                qid = str(entry.get("questionId") or entry.get("id") or "").strip()
                if qid:
                    answers.append({"questionId": qid, "text": str(entry.get("text") or "")})
            return text, answers or None
        return text, None
    return str(raw or ""), None


def _media_confirmation_accepted(tool_name: str, answers: list[dict[str, str]] | None) -> bool:
    """Validate one studio's exact closed-choice affirmative, fail closed.

    Question identifiers are part of the authorization boundary: an answer to
    the image question must never approve a video request (or vice versa), and
    free-form text is deliberately ignored for potentially billable work.
    """

    rules = {
        "imagegen": (
            "studio_confirm",
            {"Proceed (Recommended)", "继续（推荐）"},
        ),
        "videogen": (
            "video_studio_confirm",
            {"Submit (Recommended)", "提交（推荐）"},
        ),
    }
    rule = rules.get(tool_name)
    if rule is None:
        return False
    question_id, accepted = rule
    # The confirmation card has exactly one question.  Reject duplicate or
    # conflicting answer rows instead of letting one affirmative hidden among
    # them win through ``any(...)``.
    if not isinstance(answers, list) or len(answers) != 1:
        return False
    entry = answers[0]
    return (
        isinstance(entry, dict)
        and entry.get("questionId") == question_id
        and str(entry.get("text") or "").strip() in accepted
    )


def _prompt_text(prompts: dict[str, Any], path: tuple[str, ...], default: str) -> str:
    value: Any = prompts
    for key in path:
        if not isinstance(value, dict):
            return default
        value = value.get(key)
    return value if isinstance(value, str) and value else default


def _format_user_reply_body(
    text: str,
    answers: list[dict[str, str]] | None,
    ask_user_payload: dict[str, Any],
    *,
    prompts: dict[str, Any] | None = None,
) -> str:
    prompt_map = prompts or {}
    empty = _prompt_text(prompt_map, ("empty", "empty_reply"), "(empty reply)")
    skipped = _prompt_text(prompt_map, ("empty", "skipped_reply"), "(skipped)")
    question_fallback = _prompt_text(prompt_map, ("empty", "question_fallback"), "(question)")
    user_answered = _prompt_text(prompt_map, ("empty", "user_answered"), "User answered:")
    if answers:
        prompts_by_id: dict[str, str] = {}
        for q in ask_user_payload.get("questions") or []:
            if isinstance(q, dict):
                qid = str(q.get("id") or "")
                prompts_by_id[qid] = str(q.get("prompt") or qid)
        lines = [user_answered]
        for entry in answers:
            qid = entry.get("questionId", "")
            prompt = prompts_by_id.get(qid) or qid or question_fallback
            value = (entry.get("text") or "").strip() or skipped
            lines.append(f"- {prompt}\n  -> {value}")
        return "\n".join(lines)
    flat = (text or "").strip() or empty
    return f"{user_answered} {flat}"


def _flatten_ask_user_summary(ask_user_payload: dict[str, Any]) -> str:
    questions = ask_user_payload.get("questions") or []
    if isinstance(questions, list) and questions:
        prompts = [str(q.get("prompt") or "") for q in questions if isinstance(q, dict)]
        prompts = [p for p in prompts if p]
        if prompts:
            return " | ".join(prompts)
    return str(ask_user_payload.get("question") or "")


class AgenticChatPipeline:
    """Run chat as one exploring agent loop followed by a respond stage."""

    def __init__(
        self,
        language: str = "en",
        *,
        max_rounds: int | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> None:
        self.language = "zh" if language.lower().startswith("zh") else "en"
        self.llm_config = get_llm_config()
        self.binding = getattr(self.llm_config, "binding", None) or "openai"
        self.model = getattr(self.llm_config, "model", None)
        self.api_key = getattr(self.llm_config, "api_key", None)
        self.base_url = getattr(self.llm_config, "base_url", None)
        self.api_version = getattr(self.llm_config, "api_version", None)
        self.extra_headers = getattr(self.llm_config, "extra_headers", None) or {}
        self.reasoning_effort = getattr(self.llm_config, "reasoning_effort", None)
        # Process-wide registry. Stays the base for the whole turn; the
        # per-turn scoped view lives on ``_tool_view`` (see ``tool_lookup``).
        self.registry: ToolLookup = get_tool_registry()
        self._usage = UsageTracker(model=self.model)
        self._tool_view: ProviderToolView | None = None
        self._deferred_loader: DeferredToolLoader | None = None
        self._deferred_pool: list[Any] = []
        self._exec_enabled = False
        self._kb_manifests: list[KbManifest] = []
        # The blocks the turn's system prompt was rendered from, kept for the
        # context-budget breakdown (see ``measure_context_budget``).
        self._last_prompt_blocks: list[PromptBlock] = []

        try:
            chat_cfg = get_chat_params()
        except Exception as exc:
            logger.warning("Failed to load chat params, using defaults: %s", exc)
            chat_cfg = {}
        try:
            self._chat_temperature = float(chat_cfg.get("temperature", 0.2))
        except (TypeError, ValueError):
            self._chat_temperature = 0.2
        self._max_rounds = _read_int(chat_cfg, key="max_rounds", default=DEFAULT_MAX_ROUNDS)
        self._exploring_max_tokens = _read_int(
            chat_cfg.get("exploring"), key="max_tokens", default=1600
        )
        self._respond_max_tokens = _read_int(
            chat_cfg.get("responding"), key="max_tokens", default=8000
        )
        # Per-capability overrides (e.g. deep solve forwards its own round
        # budget / temperature / answer-token cap, read from the solve
        # settings). Chat itself passes none and keeps the chat_cfg values.
        if max_rounds is not None:
            self._max_rounds = max(1, int(max_rounds))
        if temperature is not None:
            self._chat_temperature = float(temperature)
        if max_tokens is not None:
            self._respond_max_tokens = max(256, int(max_tokens))

        try:
            self._prompts: dict[str, Any] = (
                get_prompt_manager().load_prompts(
                    module_name="chat",
                    agent_name="agentic_chat",
                    language=self.language,
                )
                or {}
            )
        except Exception as exc:
            logger.warning("Failed to load agentic_chat prompts: %s", exc)
            self._prompts = {}
        self._prompt_assembler = ChatPromptAssembler(
            prompts=self._prompts,
            language=self.language,
        )

    @property
    def usage(self) -> UsageTracker:
        return self._usage

    @property
    def tool_lookup(self) -> ToolLookup:
        """Registry to use for this turn.

        The scoped view once ``_prepare_deferred_tools`` has resolved it —
        which is what refuses provider tools the caller is not authorised for
        at dispatch time — and the process registry before that.

        ``getattr`` because tests construct partially-initialised pipelines
        via ``__new__`` (the same reason the mount flags read that way).
        """
        view = getattr(self, "_tool_view", None)
        return view.registry if view is not None else self.registry

    @property
    def max_rounds(self) -> int:
        return max(1, self._max_rounds)

    def effective_max_rounds(self, context: UnifiedContext) -> int:
        """Round budget for this turn, lifted to satisfy any capability minimum.

        A capability that needs guaranteed loop headroom — the subagent
        capability, which must allow its full consult budget plus a finishing
        round — sets ``context.metadata["_min_loop_rounds"]``; the loop honours
        the larger of that and the configured budget. A generic seam (like
        solve's ``solve_max_replans``) so the loop stays capability-agnostic.
        """
        try:
            floor = int(context.metadata.get("_min_loop_rounds") or 0)
        except (TypeError, ValueError):
            floor = 0
        return max(self.max_rounds, floor)

    @property
    def exploring_max_tokens(self) -> int:
        return max(128, self._exploring_max_tokens)

    @property
    def respond_max_tokens(self) -> int:
        return max(256, self._respond_max_tokens)

    @property
    def loop_max_tokens(self) -> int:
        """Single per-round token budget for the merged loop.

        The loop has no separate exploring/respond split, so every round —
        including the round that writes the final answer — uses one budget.
        It must be large enough for a full answer; the responding budget is
        that ceiling (tool-only rounds rarely approach it).
        """
        return self.respond_max_tokens

    async def run(self, context: UnifiedContext, stream: Any) -> None:
        """Production path: knorvia-daemon Thread/Turn over Knorvia Protocol."""
        from knorvia.runtime.kernel_client import stream_as_stream_events

        async for event in stream_as_stream_events(str(context.user_message or "")):
            emit = getattr(stream, "emit", None)
            if callable(emit):
                await emit(event)

    # ---- prompt assembly -------------------------------------------------

    def _build_system_prompt(
        self,
        enabled_tools: list[str],
        context: UnifiedContext,
        *,
        include_tool_manifest: bool = True,
    ) -> str:
        # Assemble once, then render: the context-budget breakdown is measured
        # from these very blocks, so a second ``blocks()`` call could drift from
        # the prompt actually sent.
        self._last_prompt_blocks = self._prompt_assembler.blocks(
            context=context,
            tool_manifest=self._tool_manifest(enabled_tools),
            kb_note=self._kb_system_note(context),
            deferred_tools_manifest=(
                self._deferred_tools_manifest() if include_tool_manifest else ""
            ),
            notebook_manifest=self._build_notebook_manifest(),
            workspace_note=self._workspace_system_note(context),
            capability_blocks=self._capability_system_blocks(context),
            include_tool_manifest=include_tool_manifest,
        )
        return self._prompt_assembler.render(self._last_prompt_blocks)

    def _tool_manifest(self, enabled_tools: list[str]) -> str:
        names = list(enabled_tools)
        if self._deferred_loader is not None:
            for name in sorted(self._deferred_loader.loaded_names):
                if name not in names:
                    names.append(name)
        try:
            return self.tool_lookup.build_prompt_text(
                names,
                format="list_with_usage",
                language=self.language,
            )
        except TypeError:
            return self.tool_lookup.build_prompt_text(names)
        except Exception:
            logger.warning("failed to build tool prompt text", exc_info=True)
            return ""

    def _tool_result_snip_marker(self) -> str:
        return self._t(
            "notices.tool_result_snipped",
            default=(
                "[earlier tool result snipped to stay within context window; "
                "call the same tool again if the content is still needed]"
            ),
        )

    # ---- deferred tools / tool composition ------------------------------

    @staticmethod
    def _is_partner_turn(context: UnifiedContext) -> bool:
        """Whether this turn runs under a partner's synthetic scope.

        A partner turn executes as a synthetic non-admin user but acts as the
        admin owner's extension. Authorization for these turns travels through
        context metadata (the owner-scoped ``mcp_tools_filter`` / exec gate),
        not the synthetic user's grant file — so callers must bypass real-user
        grant resolution and defer to that metadata whitelist instead.
        """
        return str((context.metadata or {}).get("source") or "") == "partner"

    async def _prepare_deferred_tools(self, context: UnifiedContext) -> None:
        """Resolve this turn's external-provider (MCP / CLI) tool surface.

        The policy — grant intersection, resource-derived grants, filtering,
        the progressive-disclosure loader, the manifest — lives in
        ``runtime.providers``. All the pipeline owns is translating the turn's
        context into a :class:`ToolScope`.
        """
        self._pageindex_docs = self._pageindex_doc_maps(context)
        try:
            view = await build_tool_view(
                base_registry=self.registry,
                scope=self._tool_scope(context),
                language=self.language,
                refusal_message=self._t(
                    "notices.tool_not_available",
                    default=(
                        "This tool is not available in this conversation. Only "
                        "the tools listed in the prompt can be called."
                    ),
                ),
            )
        except Exception:
            # ``build_tool_view`` is contractually non-raising; this is defence
            # in depth because it is the turn's first await — a failure here
            # would kill the turn before a single stream event is emitted.
            logger.warning("deferred-tool preparation failed", exc_info=True)
            view = ProviderToolView.empty(self.registry)
        self._tool_view = view
        self._deferred_loader = view.loader
        # Kept as a plain list: the context-budget chip counts the provider
        # tools whose schemas never entered the window.
        self._deferred_pool = list(view.pool)

    def _tool_scope(self, context: UnifiedContext) -> ToolScope:
        """Per-turn policy inputs for the provider layer."""
        from knorvia.services.mcp.pageindex_server import PAGEINDEX_SERVER_NAME

        raw_filter = context.metadata.get("mcp_tools_filter")
        return ToolScope(
            owner_id=self._current_owner_id(),
            is_partner=self._is_partner_turn(context),
            session_id=context.session_id,
            caller_whitelist=(
                frozenset(str(name) for name in raw_filter)
                if isinstance(raw_filter, list)
                else None
            ),
            # Attaching a PageIndex knowledge base authorises that server:
            # access to the KB *is* the permission, and its tools are preloaded
            # so retrieval works without a load_tools round-trip.
            implicit_provider_ids=(
                frozenset({PAGEINDEX_SERVER_NAME}) if self._pageindex_docs else frozenset()
            ),
            exclusive_capability=self._exclusive_capability_active(context),
        )

    def _pageindex_doc_maps(self, context: UnifiedContext) -> dict[str, dict[str, str]]:
        """kb_name -> {file: doc_id} for bound KBs on the pageindex provider."""
        out: dict[str, dict[str, str]] = {}
        for kb in self._selected_kbs(context):
            try:
                from knorvia.multi_user.knowledge_access import resolve_kb
                from knorvia.services.rag.factory import PAGEINDEX_PROVIDER
                from knorvia.services.rag.pipelines.pageindex.pipeline import PageIndexPipeline
                from knorvia.services.rag.provider_binding import resolve_bound_provider

                resource = resolve_kb(kb, require_write=False)
                base_dir = str(resource.base_dir)
                if resolve_bound_provider(base_dir, resource.name) != PAGEINDEX_PROVIDER:
                    continue
                out[kb] = PageIndexPipeline(kb_base_dir=base_dir).document_map(resource.name)
            except Exception:
                logger.debug("pageindex doc-map resolution failed for %r", kb, exc_info=True)
        return out

    def _deferred_tools_manifest(self) -> str:
        view = getattr(self, "_tool_view", None)
        return view.manifest if view is not None else ""

    async def _exec_allowed(self, context: UnifiedContext) -> bool:
        try:
            from knorvia.services.sandbox import IsolationLevel, get_sandbox_service

            # A partner turn runs as a synthetic non-admin user but IS the admin
            # owner's extension (partners are anchored to the admin workspace), so
            # exec follows the owner's authority — not the partner's "user" role.
            # The owner still gates exec per-partner via the builtin-tool whitelist.
            is_partner = self._is_partner_turn(context)

            level = await get_sandbox_service().isolation_level()
            if level is IsolationLevel.SYSTEM:
                # Admin can switch exec off per user (grant v2). ``None``
                # follows the policy: SYSTEM isolation serves everyone.
                from knorvia.multi_user.tool_access import exec_override

                return exec_override() is not False
            if level is IsolationLevel.APPLICATION:
                if is_partner:
                    return True
                try:
                    from knorvia.multi_user.context import get_current_user

                    return bool(get_current_user().is_admin)
                except Exception:
                    # Single-user local runtime: APPLICATION isolation is the
                    # same explicit opt-in posture TutorBot uses for local dev.
                    return True
            return False
        except Exception:
            logger.warning("exec policy gate failed; disabling exec", exc_info=True)
            return False

    def _compose_enabled_tools(self, context: UnifiedContext) -> list[str]:
        is_partner = self._is_partner_turn(context)
        composed = compose_enabled_tools(
            registry=self.tool_lookup,
            requested_tools=context.enabled_tools,
            optional_whitelist=CHAT_OPTIONAL_TOOLS,
            mount_flags=ToolMountFlags(
                # PageIndex KBs are read via the preloaded MCP tools, not rag —
                # a conversation with only PageIndex KBs doesn't mount rag at all.
                # Excludes KBs owned by an exclusive capability (an Obsidian vault
                # is read via its own tools, never rag) so a pure-vault turn still
                # doesn't mount rag, while co-selected LlamaIndex KBs do (#650).
                has_kb=bool(self._coexisting_rag_kbs(context)),
                # Attached sources reach the model through the pack/worker
                # path's own context composition, not the answer surface.
                has_sources=False,
                has_memory=user_has_memory(),
                has_notebooks=user_has_notebooks(),
                has_skills=bool(context.skills_manifest),
                has_deferred_tools=getattr(self, "_deferred_loader", None) is not None,
                has_exec=getattr(self, "_exec_enabled", False),
                has_code=getattr(self, "_exec_enabled", False),
            ),
            capability_owned=self._capability_owned_tools(context),
            exclusive=self._exclusive_capability_active(context),
            builtin_whitelist=(
                set(context.allowed_builtin_tools)
                if context.allowed_builtin_tools is not None
                else None
            ),
            # Partners get the partner_* memory/history tools force-mounted and
            # chat's read_memory/write_memory suppressed — the split-memory model
            # (own workspace writable, owner's memory read-only) lives in those
            # tools, not in chat's.
            forced=PARTNER_BUILTIN_TOOL_NAMES if is_partner else (),
            suppressed=_PARTNER_SUPPRESSED_TOOLS if is_partner else (),
        )
        return _drop_unconfigured_generation_tools(composed)

    def _active_loop_capabilities(self, context: UnifiedContext) -> tuple[LoopCapability, ...]:
        return active_loop_capabilities(context)

    @staticmethod
    def _exclusive_capability_active(context: UnifiedContext) -> bool:
        """True when a knowledge capability owns the turn (replaces the surface).

        The capability's own tools replace chat's built-ins. rag scaffolding
        (mount / KB seed / kb note) is still provided for any co-selected KBs the
        capability does NOT own — see ``_coexisting_rag_kbs`` (issue #650).
        """
        return any_exclusive_capability_active(context)

    def _capability_owned_tools(self, context: UnifiedContext) -> tuple[str, ...]:
        """The active capabilities' own tools — added on top of chat's full surface."""
        names: list[str] = []
        for cap in self._active_loop_capabilities(context):
            names.extend(cap.owned_tools)
        return tuple(names)

    def _capability_system_blocks(self, context: UnifiedContext):
        blocks = []
        for cap in self._active_loop_capabilities(context):
            block = cap.system_block(
                context,
                language=self.language,
                prompts=self._prompts,
            )
            if block is not None:
                blocks.append(block)
        return blocks

    def _build_llm_tool_schemas(
        self,
        enabled_tools: list[str],
        context: UnifiedContext,
    ) -> list[dict[str, Any]]:
        schemas = self.tool_lookup.build_openai_schemas(enabled_tools)
        kb_choices = self._coexisting_rag_kbs(context)
        notebook_choices = self._notebook_choices()
        for schema in schemas:
            function = schema.get("function") if isinstance(schema, dict) else None
            if not isinstance(function, dict):
                continue
            parameters = function.get("parameters")
            if not isinstance(parameters, dict):
                continue
            properties = parameters.get("properties") or {}
            if function.get("name") == "rag" and isinstance(properties, dict):
                if isinstance(properties.get("query"), dict):
                    properties["query"].setdefault("minLength", 1)
                if isinstance(properties.get("kb_name"), dict):
                    properties["kb_name"]["enum"] = kb_choices
            if function.get("name") == "geogebra_analysis" and isinstance(properties, dict):
                properties.pop("image_base64", None)
                required = parameters.get("required")
                if isinstance(required, list):
                    parameters["required"] = [n for n in required if n != "image_base64"]
            if (
                function.get("name") in {"list_notebook", "write_note"}
                and isinstance(properties, dict)
                and notebook_choices
                and isinstance(properties.get("notebook_id"), dict)
            ):
                nb_schema = properties["notebook_id"]
                nb_schema["enum"] = [choice["id"] for choice in notebook_choices]
                rendered = "; ".join(f"{c['id']} = {c['name']}" for c in notebook_choices)
                nb_schema["description"] = (
                    f"{nb_schema.get('description', '').rstrip(' .')}. Available: {rendered}."
                )
            parameters["additionalProperties"] = False
        return schemas

    # ---- notebook / context helpers -------------------------------------

    def _build_notebook_manifest(self) -> str:
        choices = self._notebook_choices_full()
        if not choices:
            return ""
        capped = choices[:30]
        lines = ["[用户的笔记本列表]" if self.language == "zh" else "[User's notebooks]"]
        for entry in capped:
            nid = entry.get("id", "")
            name = entry.get("name", nid)
            count = entry.get("record_count", 0)
            lines.append(f"- `{nid}` - {name} ({count} records)")
        if len(choices) > len(capped):
            lines.append(
                f"... (+{len(choices) - len(capped)} more; call `list_notebook` to see the rest)"
            )
        return "\n".join(lines)

    @staticmethod
    def _notebook_choices_full() -> list[dict[str, Any]]:
        try:
            from knorvia.services.notebook import get_notebook_manager

            notebooks = get_notebook_manager().list_notebooks() or []
        except Exception:
            return []
        rows: list[dict[str, Any]] = []
        for nb in notebooks:
            nid = str(nb.get("id") or "").strip()
            if not nid:
                continue
            name = str(nb.get("name") or nb.get("title") or nid).strip() or nid
            try:
                count = int(nb.get("record_count") or 0)
            except (TypeError, ValueError):
                count = 0
            rows.append({"id": nid, "name": name, "record_count": count})
        return rows

    @staticmethod
    def _notebook_choices() -> list[dict[str, str]]:
        return [
            {"id": str(row["id"]), "name": str(row["name"])}
            for row in AgenticChatPipeline._notebook_choices_full()
        ]

    # ---- tool execution --------------------------------------------------

    @staticmethod
    async def _publish_office_draft_metadata(
        context: UnifiedContext,
        outcome: DispatchOutcome,
        stream: Any,
    ) -> None:
        """Copy office-draft card metadata onto the turn and the event stream.

        Tool results already carry ``metadata.tool_metadata``; this extra copy
        on ``context.metadata`` is how later ``office_document`` calls in the
        same turn reuse the draft id (same pattern as video confirmation).
        """
        payload: dict[str, Any] | None = None
        for extra in outcome.tool_metadata_by_id.values():
            if not isinstance(extra, dict):
                continue
            nested = extra.get("office_draft")
            if isinstance(nested, dict) and nested.get("draft_id"):
                payload = {
                    "draft_id": str(nested.get("draft_id") or ""),
                    "files": list(nested.get("files") or []),
                    "status": str(nested.get("status") or extra.get("draft_status") or "draft"),
                }
                break
            if extra.get("draft_id"):
                payload = {
                    "draft_id": str(extra.get("draft_id") or ""),
                    "files": list(extra.get("files") or []),
                    "status": str(extra.get("draft_status") or extra.get("status") or "draft"),
                }
                break
        if not payload or not payload["draft_id"]:
            return
        context.metadata["office_draft"] = payload
        await stream.progress(
            "",
            source="chat",
            stage="responding",
            metadata={"office_draft": payload, "trace_kind": "office_draft"},
        )

    def _augment_tool_kwargs(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: UnifiedContext,
    ) -> dict[str, Any]:
        from knorvia.services.path_service import get_path_service

        kwargs = dict(args)
        turn_id = str(context.metadata.get("turn_id", "") or "").strip()
        workspace_key = self._workspace_key(context)
        task_dir = (
            get_path_service().get_task_workspace("chat", workspace_key) if workspace_key else None
        )
        exec_dir = task_dir / "exec" if task_dir is not None else None
        if tool_name == "rag":
            kwargs.setdefault("mode", "hybrid")
        elif tool_name == "kb_files":
            # The report is read by the user as much as by the model, so it is
            # written in the turn's language. Injected server-side; the tool
            # exposes no ``language`` parameter for the model to get wrong.
            kwargs["language"] = context.language or "en"
        elif tool_name in _SENDER_STAMPED_PARTNER_TOOLS:
            # Bot-to-bot DM / roster management: stamp the sender's identity
            # server-side so the receiving side can attribute the message (and
            # e.g. inherit model selection when creating a teammate) and
            # self-send is blocked. Partner session ids are "partner:<id>:<key>".
            if context.session_id.startswith("partner:"):
                sender_id = context.session_id.split(":", 2)[1]
                kwargs["_sender_partner_id"] = sender_id
                kwargs["_sender_name"] = getattr(context, "partner_name", "") or ""
        elif tool_name == "load_tools":
            kwargs["_tool_loader"] = self._deferred_loader
        elif tool_name == "exec":
            from knorvia.services.sandbox import Mount

            kwargs["_sandbox_user_id"] = self._current_user_id()
            if exec_dir is not None:
                exec_dir.mkdir(parents=True, exist_ok=True)
                kwargs["_sandbox_workdir"] = str(exec_dir)
                kwargs["_sandbox_mounts"] = (
                    Mount(host_path=str(exec_dir), sandbox_path=str(exec_dir), read_only=False),
                )
        elif tool_name in _OFFICE_TOOL_NAMES:
            # Same public exec/ turn directory as ``exec`` so /api/outputs serves
            # the xlsx/docx/pptx the tool writes. ``_workspace_dir`` is the name
            # the tool itself reads; ``_sandbox_workdir`` matches the exec/code
            # injection contract. Isolated drafts live under ``task_dir/office_drafts``.
            # Providers may emit underscore keys despite schemas, and dispatch
            # accepts plain dicts, so every server-owned ``_`` field is dropped
            # before re-injection: model input can never impersonate it.
            for forged in [key for key in kwargs if key.startswith("_")]:
                kwargs.pop(forged, None)
            kwargs["_sandbox_user_id"] = self._current_user_id()
            if exec_dir is not None:
                exec_dir.mkdir(parents=True, exist_ok=True)
                kwargs["_sandbox_workdir"] = str(exec_dir)
                kwargs["_workspace_dir"] = str(exec_dir)
            if task_dir is not None:
                kwargs["_task_dir"] = str(task_dir)
            kwargs["_session_id"] = context.session_id
            attachments = _office_attachment_manifest(context)
            if attachments:
                kwargs["_office_attachments"] = attachments
            # Client selection frozen at turn start: apply batches must stay
            # inside this sheet/range and on this revision (see office_apply).
            # Re-normalized here so contexts built outside turn_runtime
            # (partners, cron) get the same whitelist.
            from knorvia.services.office_artifacts.contracts import normalize_client_selection

            selection = normalize_client_selection(
                (context.metadata or {}).get("office_selection")
            )
            if selection:
                kwargs["_office_selection"] = selection
            draft = (context.metadata or {}).get("office_draft")
            if isinstance(draft, dict) and draft.get("draft_id"):
                kwargs["_office_draft_id"] = str(draft["draft_id"])
        elif tool_name.startswith(CLI_APP_TOOL_PREFIX):
            # A CLI app runs like exec, and for the same reason gets its workdir
            # from here rather than choosing one: one directory per turn shared by
            # every app, so the model can render with one and post-process with
            # another, and the files land where /api/outputs will serve them
            # (``PathService.is_public_output_path`` has the matching branch).
            from knorvia.services.sandbox import Mount

            kwargs["_sandbox_user_id"] = self._current_user_id()
            cli_dir = task_dir / "cli" if task_dir is not None else None
            if cli_dir is not None:
                cli_dir.mkdir(parents=True, exist_ok=True)
                kwargs["_sandbox_workdir"] = str(cli_dir)
                kwargs["_sandbox_mounts"] = (
                    Mount(host_path=str(cli_dir), sandbox_path=str(cli_dir), read_only=False),
                )
        elif tool_name == "code_execution":
            from knorvia.services.sandbox import Mount

            kwargs["_sandbox_user_id"] = self._current_user_id()
            code_dir = task_dir / "code_runs" if task_dir is not None else None
            if code_dir is not None:
                code_dir.mkdir(parents=True, exist_ok=True)
                kwargs["_sandbox_workdir"] = str(code_dir)
                kwargs["_sandbox_mounts"] = (
                    Mount(host_path=str(code_dir), sandbox_path=str(code_dir), read_only=False),
                )
        elif tool_name in ("imagegen", "videogen"):
            # Never allow a model-authored argument to impersonate the
            # server-only approval handoff.  The schema does not expose this
            # key, but providers are not guaranteed to honour schemas
            # perfectly and dispatch accepts ordinary dictionaries.
            kwargs.pop("_studio_confirmation_fingerprint", None)
            kwargs.pop("_video_confirmation_fingerprint", None)
            kwargs.pop("_video_client_request_id", None)
            kwargs.pop("_video_input_asset_ids", None)
            # Generated media lands in the turn's public workspace so it
            # surfaces as a download card via /api/outputs (same convention as
            # exec/code_execution artifacts).
            media_dir = task_dir / "media" if task_dir is not None else None
            if media_dir is not None:
                media_dir.mkdir(parents=True, exist_ok=True)
                kwargs["_workspace_dir"] = str(media_dir)
            if tool_name == "imagegen":
                kwargs["_session_id"] = context.session_id
                kwargs["_language"] = context.language or "en"
                confirmation = context.metadata.pop("_studio_confirmation_fingerprint", None)
                if confirmation:
                    kwargs["_studio_confirmation_fingerprint"] = str(confirmation)
                kwargs["_chat_attachments"] = [
                    {
                        "base64": getattr(att, "base64", "") or "",
                        "mime_type": getattr(att, "mime_type", "") or "image/png",
                        "filename": getattr(att, "filename", "") or "image.png",
                        "url": getattr(att, "url", "") or "",
                        "id": getattr(att, "id", "") or "",
                        "studio_asset_id": getattr(att, "studio_asset_id", "") or "",
                        "studio_job_id": getattr(att, "studio_job_id", "") or "",
                        "studio_project_id": getattr(att, "studio_project_id", "") or "",
                    }
                    for att in (context.attachments or [])
                    if getattr(att, "type", "") == "image"
                    and (
                        getattr(att, "base64", "")
                        or getattr(att, "url", "")
                        or getattr(att, "studio_asset_id", "")
                    )
                ]
            else:
                kwargs["_session_id"] = context.session_id
                kwargs["_language"] = context.language or "en"
                confirmation = context.metadata.pop("_video_confirmation_fingerprint", None)
                request_id = context.metadata.pop("_video_client_request_id", None)
                imported_ids = context.metadata.pop("_video_input_asset_ids", None)
                if confirmation and request_id:
                    kwargs["_video_confirmation_fingerprint"] = str(confirmation)
                    kwargs["_video_client_request_id"] = str(request_id)
                    kwargs["_video_input_asset_ids"] = list(imported_ids or [])
                kwargs["_chat_attachments"] = [
                    {
                        "base64": getattr(att, "base64", "") or "",
                        "mime_type": getattr(att, "mime_type", "") or "image/png",
                        "filename": getattr(att, "filename", "") or "image.png",
                        "url": getattr(att, "url", "") or "",
                        "id": getattr(att, "id", "") or "",
                        "studio_asset_id": getattr(att, "studio_asset_id", "") or "",
                    }
                    for att in (context.attachments or [])
                    if getattr(att, "type", "") == "image"
                    and (
                        getattr(att, "base64", "")
                        or getattr(att, "url", "")
                        or getattr(att, "studio_asset_id", "")
                    )
                ]
        elif tool_name == "cron":
            # Owner routing is supplied server-side — the model never picks
            # where a scheduled task's output lands.
            meta = context.metadata or {}
            cron_job_id = str(meta.get("cron_job_id") or meta.get("_cron_job_id") or "")
            kwargs["_cron_in_context"] = bool(
                cron_job_id or str(meta.get("source") or "") == "cron"
            )
            if self._is_partner_turn(context):
                channel_meta = meta.get("channel_metadata")
                kwargs["_cron_owner"] = {
                    "kind": "partner",
                    "partner_id": str(meta.get("partner_id") or ""),
                    "channel": str(meta.get("channel") or ""),
                    "chat_id": str(meta.get("chat_id") or ""),
                    "session_key": str(meta.get("session_key") or ""),
                    "channel_meta": dict(channel_meta) if isinstance(channel_meta, dict) else {},
                    "language": context.language or "en",
                }
            else:
                from knorvia.multi_user.context import get_current_user

                user = get_current_user()
                kwargs["_cron_owner"] = {
                    "kind": "chat",
                    "user_id": user.id,
                    "is_admin": user.is_admin,
                    "session_id": context.session_id,
                    "language": context.language or "en",
                }
        elif tool_name in {"reason", "brainstorm"}:
            kwargs.setdefault("context", context.user_message)
        elif tool_name == "paper_search":
            kwargs.setdefault("max_results", 3)
            kwargs.setdefault("years_limit", 3)
            kwargs.setdefault("sort_by", "relevance")
        elif tool_name == "web_search":
            kwargs.setdefault("query", context.user_message)
            if task_dir is not None:
                kwargs.setdefault("output_dir", str(task_dir / "web_search"))
        elif tool_name == "write_note":
            kwargs["conversation_history"] = list(context.conversation_history or [])
            kwargs["current_user_message"] = context.user_message or ""
        elif tool_name == "geogebra_analysis":
            first_image = next(
                (
                    att
                    for att in (context.attachments or [])
                    if getattr(att, "type", "") == "image" and getattr(att, "base64", "")
                ),
                None,
            )
            if first_image is not None:
                raw_b64 = first_image.base64
                if raw_b64.startswith("data:"):
                    kwargs["image_base64"] = raw_b64
                else:
                    mime = getattr(first_image, "mime_type", "") or "image/png"
                    kwargs["image_base64"] = f"data:{mime};base64,{raw_b64}"
            kwargs["language"] = context.language or "zh"
        for cap in self._active_loop_capabilities(context):
            kwargs = cap.augment_kwargs(tool_name, kwargs, context)
        return kwargs

    def _retrieve_trace_metadata(
        self,
        tool_meta: dict[str, Any],
        *,
        context: UnifiedContext,
        tool_name: str,
        tool_args: dict[str, Any],
    ) -> dict[str, Any] | None:
        _ = context
        if tool_name == "rag":
            return derive_trace_metadata(
                tool_meta,
                label=self._t("labels.retrieve", default="Retrieve"),
                call_kind="rag_retrieval",
                trace_role="retrieve",
                trace_group="retrieve",
                query=str(tool_args.get("query", "") or ""),
            )
        # The remaining entries are pure label/call_kind customisation: every
        # tool now gets an event_sink and a call_state unconditionally
        # (``execute_tool_call``), so a long-running tool no longer has to pose
        # as a retrieval to stream its progress. What it still needs from here
        # is the call_kind the frontend renders it by.
        if tool_name in ("imagegen", "videogen"):
            return derive_trace_metadata(
                tool_meta,
                label=self._t("labels.tool_call", default="Tool call"),
                call_kind="media_generation",
                query=str(tool_args.get("prompt", "") or ""),
            )
        # consult_subagent drives a live local agent; the frontend keys its
        # in-place transcript row off this call_kind.
        if tool_name == "consult_subagent":
            return derive_trace_metadata(
                tool_meta,
                label=self._t("labels.consult_subagent", default="Consult agent"),
                call_kind="subagent_consult",
                query=str(tool_args.get("question", "") or ""),
            )
        return None

    # ---- KB seed ---------------------------------------------------------

    # ---- emissions / context guard --------------------------------------

    async def _emit_final_text(
        self,
        stream: Any,
        text: str,
        final_meta: dict[str, Any],
    ) -> None:
        if not text:
            return
        await stream.content(
            text,
            source="chat",
            stage="responding",
            metadata=merge_trace_metadata(final_meta, {"trace_kind": "llm_output"}),
        )

    async def _emit_terminator_final_response(
        self,
        stream: Any,
        payload: dict[str, Any] | None,
    ) -> None:
        if not payload:
            return
        content = str(payload.get("content") or "").strip()
        if not content:
            return
        final_meta = build_trace_metadata(
            call_id=new_call_id("chat-final-response"),
            phase="responding",
            label=self._t("labels.final_response", default="Final response"),
            call_kind="llm_final_response",
            trace_id="chat-final-response",
            trace_role="response",
            trace_group="stage",
            terminator_tool=str(payload.get("tool_name") or ""),
        )
        merged: dict[str, Any] = {"trace_kind": "llm_output"}
        tool_metadata = payload.get("metadata") or {}
        if isinstance(tool_metadata, dict) and tool_metadata:
            merged["tool_metadata"] = dict(tool_metadata)
        await stream.content(
            content,
            source="chat",
            stage="responding",
            metadata=merge_trace_metadata(final_meta, merged),
        )

    def _unloaded_deferred_tool_count(self, loaded: set[str]) -> int:
        """Extended tools whose full schemas never entered the window.

        They cost only their manifest line (the ``extended_tools`` block), so
        they are reported as a scalar rather than as a segment.
        """
        try:
            pool = getattr(self, "_deferred_pool", None) or []
            return sum(1 for tool in pool if tool.get_definition().name not in loaded)
        except Exception:
            logger.debug("deferred-tool count probe failed", exc_info=True)
            return 0

    @staticmethod
    def _estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
        from knorvia.services.session.context_builder import count_tokens

        total = 0
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, str):
                total += count_tokens(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        total += count_tokens(str(part.get("text") or ""))
        return total

    # ---- LLM client ------------------------------------------------------

    def _can_use_native_tool_calling(self) -> bool:
        return can_use_native_tool_calling(binding=self.binding, model=self.model)

    # ---- small helpers ---------------------------------------------------

    @staticmethod
    def _current_user_id() -> str:
        try:
            from knorvia.multi_user.context import get_current_user

            return str(get_current_user().id or "anonymous")
        except Exception:
            return "anonymous"

    @staticmethod
    def _current_owner_id() -> str:
        """Id of the owning account — NOT the same as ``_current_user_id``.

        A partner resolves to the person who owns it and an administrator to the
        deployment id, which is how owner-keyed state (a caller's own MCP
        servers and their credentials) is addressed everywhere else. Using the
        raw current-user id here would have an admin's self-configured servers
        written under one name and read under another.
        """
        try:
            from knorvia.multi_user.paths import current_owner_id

            return current_owner_id()
        except Exception:
            logger.debug("owner id resolution failed", exc_info=True)
            return ""

    @staticmethod
    def _selected_kbs(context: UnifiedContext) -> list[str]:
        return [str(kb).strip() for kb in context.knowledge_bases if str(kb).strip()]

    def _rag_kbs(self, context: UnifiedContext) -> list[str]:
        """Attached KBs served by the rag tool (PageIndex KBs are read via MCP)."""
        pageindex = getattr(self, "_pageindex_docs", None) or {}
        return [kb for kb in self._selected_kbs(context) if kb not in pageindex]

    def _capability_owned_kbs(self, context: UnifiedContext) -> set[str]:
        """Selected KBs consumed by an active capability's own tools (not rag).

        An exclusive knowledge capability (Obsidian) reads its vault through its
        own tools; those KB refs must be excluded from the rag surface. Read via
        ``getattr`` so plain capabilities without the seam are unaffected.
        """
        owned: set[str] = set()
        for cap in self._active_loop_capabilities(context):
            hook = getattr(cap, "owned_kbs", None)
            if callable(hook):
                owned |= set(hook(context))
        return owned

    def _coexisting_rag_kbs(self, context: UnifiedContext) -> list[str]:
        """rag-served KBs that coexist with an exclusive knowledge capability.

        When an Obsidian vault owns the turn, co-selected LlamaIndex KBs would
        otherwise be silently dropped (issue #650). These stay reachable via
        rag; vault KBs (which have no rag index) are excluded. Equals
        ``_rag_kbs`` for a plain chat turn (no capability owns any KB).
        """
        owned = self._capability_owned_kbs(context)
        return [kb for kb in self._rag_kbs(context) if kb not in owned]

    @staticmethod
    def _workspace_key(context: UnifiedContext) -> str:
        raw = str(
            context.metadata.get("turn_id")
            or context.session_id
            or context.metadata.get("message_id")
            or "direct"
        )
        cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in raw)
        return cleaned.strip("_") or "direct"

    def _kb_system_note(self, context: UnifiedContext) -> str:
        if not self._selected_kbs(context):
            return ""
        rag_note = ""
        # Coexisting rag KBs only: when an Obsidian vault owns the turn, its own
        # system block covers the vault, and this note tells the model the
        # co-selected LlamaIndex KBs are reachable via rag (issue #650). A
        # pure-vault turn yields no coexisting KBs, so the note stays empty.
        rag_kbs = self._coexisting_rag_kbs(context)
        if rag_kbs:
            joined = ", ".join(rag_kbs)
            rag_note = (
                f"用户已挂载知识库：{joined}。调用 rag 时，kb_name 必须从其中选一个。"
                if self.language == "zh"
                else (
                    f"Attached knowledge bases: {joined}. When calling rag, kb_name "
                    "must be one of these names."
                )
            )
        return rag_note + self._kb_manifest_system_note() + self._pageindex_system_note()

    async def _prepare_kb_manifests(self, context: UnifiedContext) -> None:
        """Read the attached KBs' document inventories once per turn.

        Retrieval cannot answer "how many files are in here" — the passages it
        returns say nothing about the size of the collection they came from. The
        inventory is a filesystem fact, so it is read here (off the event loop,
        one directory walk per KB) and rendered into the system prompt, which
        keeps the prompt byte-stable for the whole turn and makes counts
        answerable without a tool round-trip.

        PageIndex KBs are excluded: ``_pageindex_system_note`` already lists
        their documents, with the doc_ids its MCP tools need. Fails soft — a KB
        whose files cannot be read costs the manifest, not the turn.
        """
        self._kb_manifests = []
        kbs = self._rag_kbs(context)
        if not kbs:
            return
        try:
            self._kb_manifests = await asyncio.to_thread(self._collect_kb_manifests, kbs)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Failed to build knowledge base manifests: %s", exc)

    @staticmethod
    def _collect_kb_manifests(kbs: list[str]) -> list[KbManifest]:
        from knorvia.multi_user.knowledge_access import resolve_kb_manifest

        manifests: list[KbManifest] = []
        for kb in kbs:
            try:
                manifest = resolve_kb_manifest(kb)
            except Exception as exc:
                logger.warning("Failed to read documents of knowledge base '%s': %s", kb, exc)
                continue
            if manifest is not None:
                manifests.append(manifest)
        return manifests

    def _kb_manifest_system_note(self) -> str:
        """What the attached KBs contain, from :meth:`_prepare_kb_manifests`."""
        if not self._kb_manifests:
            return ""
        note = render_manifest_note(self._kb_manifests, language=self.language)
        return f"\n{note}" if note else ""

    def _pageindex_system_note(self) -> str:
        """Doc list + retrieval instructions for attached PageIndex KBs.

        Populated by ``_prepare_deferred_tools`` once per turn, so the system
        prompt stays byte-stable for the whole turn (KB cache prefix).
        """
        doc_maps = getattr(self, "_pageindex_docs", None) or {}
        if not doc_maps:
            return ""
        lines = []
        for kb, doc_map in sorted(doc_maps.items()):
            listed = "; ".join(
                f"{name} (doc_id: {doc_id})" for name, doc_id in sorted(doc_map.items())
            )
            lines.append(f"- {kb}: {listed or '(no indexed documents)'}")
        docs_block = "\n".join(lines)
        if self.language == "zh":
            return (
                "\n以下知识库使用托管的 PageIndex 引擎，其文档通过已加载的 "
                "PageIndex MCP 工具阅读：先用 mcp_pageindex_get_document_structure "
                "查看结构，再用 mcp_pageindex_get_page_content 读取相关页面。文档清单：\n"
                f"{docs_block}"
            )
        return (
            "\nThe following knowledge bases are on the hosted PageIndex engine; read "
            "their documents with the preloaded PageIndex MCP tools: "
            "mcp_pageindex_get_document_structure for the outline, then "
            "mcp_pageindex_get_page_content for the relevant pages. Documents:\n"
            f"{docs_block}"
        )

    def _workspace_system_note(self, context: UnifiedContext) -> str:
        if not getattr(self, "_exec_enabled", False):
            return ""
        try:
            from knorvia.services.path_service import get_path_service

            exec_dir = (
                get_path_service().get_task_workspace(
                    "chat",
                    self._workspace_key(context),
                )
                / "exec"
            )
        except Exception:
            return ""
        if self.language == "zh":
            return (
                "[本轮工作区]\n"
                f"脚本和临时文件应写入：{exec_dir}\n"
                "相对路径会解析到这个目录。需要创建 PDF、图片、表格或其他下载文件时，"
                "直接通过 exec 写入并运行脚本（如 heredoc：python - <<'PY' … PY，"
                "或 cat > gen.py <<'EOF' … EOF 后再运行）。生成的文件会自动以可下载"
                "卡片呈现给用户——在回答里描述你做了什么即可，不要粘贴原始 URL。"
            )
        return (
            "[Turn workspace]\n"
            f"Scripts and temporary files should be written under: {exec_dir}\n"
            "Relative paths resolve to this directory. When creating PDFs, images, "
            "spreadsheets, or other downloadable files, write and run scripts directly "
            "through exec (e.g. a heredoc: python - <<'PY' … PY, or cat > gen.py <<'EOF' "
            "… EOF then run it). Generated files are shown to the user automatically as "
            "downloadable cards — describe what you made, do not paste raw URLs."
        )

    def _t(self, key: str, default: str = "", **kwargs: Any) -> str:
        value: Any = self._prompts
        for part in key.split("."):
            if not isinstance(value, dict) or part not in value:
                value = default
                break
            value = value[part]
        if not isinstance(value, str):
            value = default
        if kwargs:
            try:
                return value.format(**kwargs)
            except (KeyError, IndexError, ValueError):
                return value
        return value


__all__ = [
    "AgenticChatPipeline",
    "CHAT_OPTIONAL_TOOLS",
    "KB_SEED_CHARS_PER_KB",
    "KB_SEED_MAX_KBS",
    "_DispatchOutcome",
    "_read_int",
]
