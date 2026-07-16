# career-ops — production server image (Slack/Telegram webhook bot)
#
# Runs server.mjs (Express) for remote access.
# Base: Playwright image with Chromium preinstalled.

FROM mcr.microsoft.com/playwright:v1.61.1-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080

# tini for clean signal handling / zombie reaping; git in case a git-commit-back
# persistence option is enabled.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git tini; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cached layer).
COPY package.json ./
RUN npm install --no-audit --no-fund

# Bake the sources in (respects .dockerignore).
COPY . .

# Setup runtime symlinks to Secret Manager mounts to bypass Cloud Run directory mount masking/collisions
RUN ln -sf /secrets/cv/cv.md /app/cv.md && \
    ln -sf /secrets/profile/profile.yml /app/config/profile.yml && \
    ln -sf /secrets/modes-profile/_profile.md /app/modes/_profile.md && \
    ln -sf /secrets/modes-custom/_custom.md /app/modes/_custom.md && \
    ln -sf /secrets/portals/portals.yml /app/portals.yml && \
    ln -sf /secrets/voice-dna/voice-dna.md /app/voice-dna.md

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
