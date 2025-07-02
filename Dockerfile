FROM node:20-slim AS base

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
ADD . .

EXPOSE 42069

ENV DATABASE_SCHEMA=$DATABASE_SCHEMA
CMD [ "pnpm", "start" ]