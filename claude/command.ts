import type { ClaudeResponse, ClaudeMessage } from "./types.ts";
import { sendToClaudeCode, type ClaudeModelOptions } from "./client.ts";
import { convertToClaudeMessages } from "./message-converter.ts";
import { SlashCommandBuilder } from "npm:discord.js@14.14.1";

// Callback that creates (or retrieves) a session thread and returns a
// sender function bound to that thread.
export interface SessionThreadCallbacks {
  /**
   * Create a new Discord thread for this session and return a sender bound to it.
   * Also posts a summary embed in the main channel linking to the thread.
   *
   * @param prompt The user's prompt (used to name the thread)
   * @param sessionId Optional pre-existing session ID (reuses thread if one exists)
   * @returns Object with the thread-bound sender and a placeholder session key
   */
  createThreadSender(prompt: string, sessionId?: string, threadName?: string): Promise<{
    sender: (messages: ClaudeMessage[]) => Promise<void>;
    threadSessionKey: string;
    threadChannelId: string;
  }>;
  /**
   * Look up an existing thread for a session (does NOT create one).
   * Returns undefined if the session has no thread.
   */
  getThreadSender(sessionId: string): Promise<{
    sender: (messages: ClaudeMessage[]) => Promise<void>;
    threadSessionKey: string;
  } | undefined>;
  /**
   * Update the session key mapping when the real SDK session ID arrives.
   */
  updateSessionId(oldKey: string, newSessionId: string): void;
}

// Discord command definitions
export const claudeCommands = [
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Send message to Claude Code (auto-continues in current channel)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('session_id')
        .setDescription('Session ID to resume (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-thread')
    .setDescription('Start a new Claude session in a dedicated thread')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Thread name')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the most recent Claude Code session (across all channels)')
    .addStringOption(option =>
      option.setName('prompt')
        .setDescription('Prompt for Claude Code (optional)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('claude-cancel')
    .setDescription('Cancel currently running Claude Code command'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear this channel\'s conversation — the next message starts fresh'),
];

export interface ClaudeHandlerDeps {
  workDir: string;
  getClaudeController: () => AbortController | null;
  setClaudeController: (controller: AbortController | null) => void;
  /** Get session ID for a specific channel/thread (per-channel tracking) */
  getSessionForChannel: (channelId: string) => string | undefined;
  /** Set session ID for a specific channel/thread */
  setSessionForChannel: (channelId: string, sessionId: string | undefined) => void;
  /** Legacy global getter (for /resume — find most recent across channels) */
  getClaudeSessionId: () => string | undefined;
  /** Legacy global setter (keeps backward compat for session manager) */
  setClaudeSessionId: (sessionId: string | undefined) => void;
  /** Default sender — used when no thread is available (fallback) */
  sendClaudeMessages: (messages: ClaudeMessage[]) => Promise<void>;
  /** Get current runtime options from unified settings (thinking, operation, proxy) */
  getQueryOptions?: () => ClaudeModelOptions;
  /** Thread-per-session callbacks (optional — when absent, falls back to main channel) */
  sessionThreads?: SessionThreadCallbacks;
  /** Set the channel/thread the active turn streams to, so AskUserQuestion and
   *  permission prompts go there. Called with null to default to the main
   *  channel; the sessionThreads callbacks set it to a thread when one is used. */
  // deno-lint-ignore no-explicit-any
  setActiveTurnChannel?: (channel: any) => void;
  /** WorktreeManager for per-session git worktree isolation (optional). */
  worktreeManager?: import("../git/worktree-manager.ts").WorktreeManager;
}

export function createClaudeHandlers(deps: ClaudeHandlerDeps) {
  const { workDir, sendClaudeMessages } = deps;

  /** Resolve the working directory for a session — uses a worktree if available. */
  async function resolveWorkDir(channelId: string): Promise<string> {
    if (!deps.worktreeManager) return workDir;
    try {
      return await deps.worktreeManager.acquire(channelId);
    } catch (err) {
      console.warn("[Worktree] Failed to acquire, falling back to main:", err instanceof Error ? err.message : err);
      return workDir;
    }
  }

  /** Commit worktree state after a turn (crash-safe backup). */
  async function commitAfterTurn(channelId: string): Promise<void> {
    if (!deps.worktreeManager) return;
    try {
      await deps.worktreeManager.commitWorktree(channelId);
    } catch (err) {
      console.warn("[Worktree] Post-turn commit failed:", err instanceof Error ? err.message : err);
    }
  }

  return {
    /**
     * /claude — Send a message to Claude. Auto-continues the session active in the
     * current channel/thread. Starts a new session only if there isn't one yet.
     */
    // deno-lint-ignore no-explicit-any
    async onClaude(ctx: any, prompt: string, channelId: string, explicitSessionId?: string, overrideSender?: (messages: ClaudeMessage[]) => Promise<void>): Promise<ClaudeResponse> {
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      await ctx.deferReply();

      // Resolve which session to resume:
      // 1) Explicit session_id from user → resume that
      // 2) Active session in this channel/thread → resume that
      // 3) None → start a new session
      const activeSessionId = explicitSessionId || deps.getSessionForChannel(channelId);

      // Resolve worktree-isolated working directory for this channel
      const sessionWorkDir = await resolveWorkDir(channelId);

      // Pick the right sender. An explicit overrideSender (e.g. from a natural
      // message) targets the exact channel/thread the request arrived in — robust
      // across restarts, unlike the in-memory session→thread map (which is empty
      // after a restart and never set for threads not created via /claude-thread).
      let activeSender = overrideSender || sendClaudeMessages;
      // Route AskUser/permission prompts to the right place. With an override
      // sender (natural message) the caller already set the active-turn channel.
      // Otherwise default to the main channel; getThreadSender below resets it to
      // the session's thread if one exists, so prompts don't leak to a stale
      // thread from a previous turn.
      if (!overrideSender) {
        deps.setActiveTurnChannel?.(null);
        if (activeSessionId && deps.sessionThreads) {
          try {
            const existing = await deps.sessionThreads.getThreadSender(activeSessionId);
            if (existing) {
              activeSender = existing.sender;
            }
          } catch { /* fallback to main sender */ }
        }
      }

      const isResuming = !!activeSessionId;

      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: isResuming ? 'Claude Code Continuing...' : 'Claude Code Running...',
          description: isResuming ? 'Continuing session...' : 'Starting new session...',
          fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true
        }]
      });

      const result = await sendToClaudeCode(
        sessionWorkDir,
        prompt,
        controller,
        activeSessionId, // resume if present, new session if undefined
        undefined,
        (jsonData) => {
          // Persist the channel→session mapping as soon as the SDK reports the
          // session id — not only after the turn completes. Otherwise a turn
          // interrupted by a follow-up message (which aborts it) never records
          // its session, so the next message can't resume it and starts fresh.
          const sid = (jsonData as { session_id?: string })?.session_id;
          if (sid && deps.getSessionForChannel(channelId) !== sid) {
            deps.setSessionForChannel(channelId, sid);
          }
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        false,
        deps.getQueryOptions?.()
      );

      // Commit worktree changes after the turn (crash-safe backup)
      await commitAfterTurn(channelId);

      // Track session per-channel and globally
      if (result.sessionId) {
        deps.setSessionForChannel(channelId, result.sessionId);
      }
      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

      return result;
    },

    /**
     * /claude-thread — Start a brand-new session in a dedicated Discord thread.
     */
    // deno-lint-ignore no-explicit-any
    async onClaudeThread(ctx: any, prompt: string, threadName?: string): Promise<ClaudeResponse> {
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      await ctx.deferReply();

      // Create a dedicated thread for this session
      let activeSender = sendClaudeMessages;
      let threadSessionKey: string | undefined;
      let threadChannelId: string | undefined;

      // Default to the main channel; createThreadSender resets this to the new
      // thread on success, so AskUser/permission prompts go to the thread.
      deps.setActiveTurnChannel?.(null);

      if (deps.sessionThreads) {
        try {
          const threadResult = await deps.sessionThreads.createThreadSender(prompt, undefined, threadName);
          activeSender = threadResult.sender;
          threadSessionKey = threadResult.threadSessionKey;
          threadChannelId = threadResult.threadChannelId;
        } catch (err) {
          console.warn('[SessionThread] Could not create thread, falling back to main channel:', err);
        }
      }

      // Resolve worktree for the thread channel (or generate a temporary ID)
      const wtId = threadChannelId || `thread-${Date.now()}`;
      const sessionWorkDir = await resolveWorkDir(wtId);

      await ctx.editReply({
        embeds: [{
          color: 0xffff00,
          title: 'Claude Code Running...',
          description: threadSessionKey
            ? 'Session started in a dedicated thread — check below ↓'
            : 'Starting new session...',
          fields: [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }],
          timestamp: true
        }]
      });

      const result = await sendToClaudeCode(
        sessionWorkDir,
        prompt,
        controller,
        undefined, // always a new session
        undefined,
        (jsonData) => {
          // Map this thread to its session as soon as the SDK reports the id, so
          // a follow-up message in the thread resumes it even if this turn is
          // interrupted before it completes (e.g. plan presented, then "apply").
          const sid = (jsonData as { session_id?: string })?.session_id;
          if (sid && threadChannelId && deps.getSessionForChannel(threadChannelId) !== sid) {
            deps.setSessionForChannel(threadChannelId, sid);
          }
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        false,
        deps.getQueryOptions?.()
      );

      // Commit worktree after turn
      await commitAfterTurn(wtId);

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

      // Map the thread channel → session so /claude inside the thread auto-continues
      if (threadSessionKey && result.sessionId && deps.sessionThreads) {
        deps.sessionThreads.updateSessionId(threadSessionKey, result.sessionId);
      }
      if (threadChannelId && result.sessionId) {
        deps.setSessionForChannel(threadChannelId, result.sessionId);
      }

      return result;
    },

    /**
     * /resume — Continue the most recent session (global, not per-channel).
     * If that session has a thread, output goes there.
     */
    // deno-lint-ignore no-explicit-any
    async onContinue(ctx: any, prompt?: string): Promise<ClaudeResponse> {
      const existingController = deps.getClaudeController();
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      deps.setClaudeController(controller);

      const actualPrompt = prompt || "Please continue.";

      await ctx.deferReply();

      // Check if the most recent session has a thread — if so, reuse it
      let activeSender = sendClaudeMessages;
      let isReusingThread = false;

      // Default AskUser/permission prompts to the main channel; getThreadSender
      // below resets it to the session's thread when one is reused.
      deps.setActiveTurnChannel?.(null);

      if (deps.sessionThreads) {
        const currentSessionId = deps.getClaudeSessionId();
        if (currentSessionId) {
          try {
            const existing = await deps.sessionThreads.getThreadSender(currentSessionId);
            if (existing) {
              activeSender = existing.sender;
              isReusingThread = true;
            }
          } catch (err) {
            console.warn('[SessionThread] Could not reuse thread for continue, falling back:', err);
          }
        }
      }

      const embedData: { color: number; title: string; description: string; timestamp: boolean; fields?: Array<{ name: string; value: string; inline: boolean }> } = {
        color: 0xffff00,
        title: 'Claude Code Continuing Conversation...',
        description: isReusingThread
          ? 'Continuing in session thread...'
          : 'Loading latest conversation and waiting for response...',
        timestamp: true
      };

      if (prompt) {
        embedData.fields = [{ name: 'Prompt', value: `\`${prompt.substring(0, 1020)}\``, inline: false }];
      }

      await ctx.editReply({ embeds: [embedData] });

      const result = await sendToClaudeCode(
        workDir,
        actualPrompt,
        controller,
        undefined,
        undefined,
        (jsonData) => {
          const claudeMessages = convertToClaudeMessages(jsonData);
          if (claudeMessages.length > 0) {
            activeSender(claudeMessages).catch(() => {});
          }
        },
        true, // continueMode = true
        deps.getQueryOptions?.()
      );

      deps.setClaudeSessionId(result.sessionId);
      deps.setClaudeController(null);

      return result;
    },

    // deno-lint-ignore no-explicit-any
    onClaudeCancel(_ctx: any): boolean {
      const currentController = deps.getClaudeController();
      if (!currentController) {
        return false;
      }

      console.log("Cancelling Claude Code session...");
      currentController.abort();
      deps.setClaudeController(null);
      deps.setClaudeSessionId(undefined);

      return true;
    },

    /**
     * /clear — reset this channel/thread's session so the next message starts a
     * fresh conversation (Claude's transcript stays on disk; we just stop
     * resuming it for this channel). Also merges and releases the worktree.
     */
    onClear(channelId: string): void {
      const existing = deps.getClaudeController();
      if (existing) existing.abort();
      deps.setClaudeController(null);
      deps.setSessionForChannel(channelId, undefined);
      deps.setClaudeSessionId(undefined);
      // Release worktree asynchronously (merge changes back to main)
      if (deps.worktreeManager?.has(channelId)) {
        deps.worktreeManager.release(channelId).catch((err) => {
          console.warn("[Worktree] Release on clear failed:", err instanceof Error ? err.message : err);
        });
      }
    }
  };
}
