FROM node:alpine

ARG DATABASE_SCHEMA=default-schema
# Forc es the var to be defined
# https://stackoverflow.com/a/54712127
RUN test -n "$DATABASE_SCHEMA" || (echo "DATABASE_SCHEMA not set" && false)
ENV DATABASE_SCHEMA=$DATABASE_SCHEMA

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install
ADD . .

EXPOSE 42069


CMD [ "pnpm", "start" ]