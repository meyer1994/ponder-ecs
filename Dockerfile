FROM node:alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install
ADD . .

EXPOSE 42069
ENV DATABASE_SCHEMA=$DATABASE_SCHEMA


CMD [ "pnpm", "start" ]