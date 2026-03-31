FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++ git bash ffmpeg
WORKDIR /app
ARG NODE_OPTIONS=--max-old-space-size=12288
ENV NODE_OPTIONS=${NODE_OPTIONS}

COPY package.json yarn.lock ./
COPY bin ./bin
COPY scripts ./scripts
COPY tools ./tools
RUN yarn install --frozen-lockfile --ignore-engines

FROM deps AS builder
COPY . .
RUN yarn build

FROM node:22-alpine AS runner
RUN apk add --no-cache bash git openssh-client ffmpeg dumb-init
WORKDIR /app

ENV NODE_ENV=production \
    AHA_HOME_DIR=/home/node/.aha-v13 \
    AHA_HOME_COMPAT_DIR=/home/node/.aha-v12 \
    NODE_OPTIONS=--max-old-space-size=12288 \
    AHA_DISABLE_CAFFEINATE=true

COPY package.json yarn.lock ./
COPY bin ./bin
COPY scripts ./scripts
COPY tools ./tools
RUN yarn install --frozen-lockfile --production=true --ignore-engines && yarn cache clean

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY docker/entrypoint.sh /usr/local/bin/aha-cli-entrypoint
RUN chmod +x /usr/local/bin/aha-cli-entrypoint \
  && mkdir -p /home/node/.aha-v13 /home/node/.aha-v12 \
  && chown -R node:node /app /home/node

USER node
VOLUME ["/home/node/.aha-v13"]
ENTRYPOINT ["dumb-init", "--", "aha-cli-entrypoint"]
CMD ["node", "--no-warnings", "--no-deprecation", "dist/index.mjs", "daemon", "start-sync"]
