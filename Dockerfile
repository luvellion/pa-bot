# Claude Code Discord Bot
# Optimized production image with Claude CLI

FROM denoland/deno:latest

# Build arguments for user UID/GID (match host user to avoid permission issues)
ARG USER_ID=1000
ARG GROUP_ID=1000

# Set working directory
WORKDIR /app

# Set environment variable to indicate Docker container
ENV DOCKER_CONTAINER=true

# Install system dependencies
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates nodejs npm && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user with home directory (needed for Claude CLI config)
RUN groupadd -r -g ${GROUP_ID} claude && \
    useradd -r -u ${USER_ID} -g claude -m claude

# Install Claude Code CLI + the Google Calendar MCP globally so the MCP loads
# instantly (no runtime npx download, which can time out on a cold cache after
# a restart and leave the agent without calendar tools).
RUN npm install -g @anthropic-ai/claude-code @cocal/google-calendar-mcp && \
    npm cache clean --force

# Verify claude binary is accessible
RUN claude --version

# kubectl (read-only homelab diagnostics for the homelab-kubernetes subagent) and
# gh (PR creation for homelab-developer). Image is linux/arm64.
RUN curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/arm64/kubectl" && \
    chmod +x /usr/local/bin/kubectl && \
    GH_VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep '"tag_name"' | head -1 | sed -E 's/.*"v([^"]+)".*/\1/') && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_arm64.tar.gz" | tar -xz -C /tmp && \
    mv "/tmp/gh_${GH_VER}_linux_arm64/bin/gh" /usr/local/bin/gh && \
    rm -rf /tmp/gh_* && \
    kubectl version --client && gh --version

# Copy all source files (as root)
COPY . .

# Remove lockfile if present (avoid version conflicts)
RUN rm -f deno.lock

# Initialize git repo in container (for non-git workspaces)
RUN git init && git config user.email "bot@claude.local" && git config user.name "Claude Bot"

# Pre-compile Deno dependencies
RUN deno cache --no-lock index.ts

# Create data directory for persistence + workspace dir, set ownership
RUN mkdir -p .bot-data /app/workspace /home/claude/.claude && \
    cd /app/workspace && git init && git config user.email "bot@claude.local" && git config user.name "Claude Bot" && \
    chown -R claude:claude /app /home/claude

# Switch to non-root user
USER claude

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD deno eval "console.log('healthy')" || exit 1

# Default command
CMD ["deno", "run", "--allow-all", "--no-lock", "index.ts"]

# Labels for image metadata
LABEL org.opencontainers.image.source="https://github.com/zebbern/claude-code-discord"
LABEL org.opencontainers.image.description="Claude Code Discord Bot - Use Claude AI via Discord"
LABEL org.opencontainers.image.licenses="MIT"
