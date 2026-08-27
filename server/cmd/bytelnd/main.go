package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/byteln/byteln/server/internal/config"
	"github.com/byteln/byteln/server/internal/relay"
)

// Set via -ldflags "-X main.version=v1.2.3" on release builds.
var version = "dev"

func main() {
	log.Printf("bytelnd %s", version)
	cfg := config.FromEnv()
	srv, err := relay.New(cfg)
	if err != nil {
		log.Fatalf("relay: %v", err)
	}

	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
		<-ch
		log.Printf("shutting down")
		srv.Shutdown()
	}()

	if err := srv.ListenAndServe(cfg.Listen); err != nil {
		log.Fatalf("listen: %v", err)
	}
}
