.PHONY: build-server build-web test docker clean dev dev-all

# Relay listen port (override: make dev PORT=9000)
PORT ?= 8990
WEB_PORT ?= 5173

build-server:
	cd server && CGO_ENABLED=0 go build -o bin/bytelnd ./cmd/bytelnd

build-web:
	cd web && npm run build

test:
	cd server && go test ./internal/...

docker:
	docker build -t byteln:local .

clean:
	rm -rf server/bin web/build

# Run relay + web client together (Ctrl-C stops both).
dev: dev-all

dev-all:
	@echo "bytelnd → :$(PORT)  |  web → :$(WEB_PORT)"
	@trap 'kill 0' EXIT INT TERM; \
		(cd server && BYTELN_PORT=$(PORT) go run ./cmd/bytelnd) & \
		(cd web && PUBLIC_DEFAULT_RELAY=ws://127.0.0.1:$(PORT) npm run dev -- --host 127.0.0.1 --port $(WEB_PORT)) & \
		wait
