# The public API and demo, with Chrome, in its own network namespace: nothing on the host's loopback
# (where other services listen) is reachable from the pages the agent opens.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates fonts-liberation fonts-noto-color-emoji \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 10001 agent
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY demo ./demo
RUN mkdir -p /data && chown agent /data
USER agent

ENV PORT=8790 \
    JEVIM_DATA=/data \
    JEVIM_BLOCK_PRIVATE=1 \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    JEVIM_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"
EXPOSE 8790
CMD ["node", "server/public.mjs"]
