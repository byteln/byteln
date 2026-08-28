# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS server-build
WORKDIR /src
COPY server/ ./
RUN CGO_ENABLED=0 go build -o /bytelnd ./cmd/bytelnd

FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG PUBLIC_DEFAULT_RELAY=wss://byteln.com
ARG PUBLIC_DIRECTORY_URL=
ENV PUBLIC_DEFAULT_RELAY=$PUBLIC_DEFAULT_RELAY
ENV PUBLIC_DIRECTORY_URL=$PUBLIC_DIRECTORY_URL
RUN npm run build

FROM alpine:3.21 AS relay
RUN apk add --no-cache ca-certificates
COPY --from=server-build /bytelnd /usr/local/bin/bytelnd
ENV BYTELN_PORT=8990
EXPOSE 8990
ENTRYPOINT ["bytelnd"]

FROM nginx:1.27-alpine AS web
COPY --from=web-build /web/build /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
