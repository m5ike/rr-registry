# RR Registry - maintainer m5ike
#   make menuconfig   configure port, admin password, api token (.env)
#   make up           build image and start the web backend in Docker
#   make help         list all targets
SHELL := /bin/bash
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
-include .env
RR_PORT ?= 4873
RR_DATA_PATH ?= ./data
VERSION := $(shell cat VERSION)

.DEFAULT_GOAL := help
.PHONY: envfile help menuconfig config build clients up start down stop restart logs ps status shell run dev test test-unit test-e2e test-docker update install uninstall backup restore clean distclean image

help: ## Zobrazí nápovědu
	@echo "RR Registry $(VERSION) - make cíle:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' Makefile | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

menuconfig: ## GUI konfigurace (port, admin heslo, api_token...) -> .env
	@bash scripts/menuconfig.sh

config: ## Neinteraktivní konfigurace s výchozími hodnotami (vygeneruje hesla)
	@bash scripts/menuconfig.sh --defaults

envfile:
	@[ -f .env ] || { echo ".env neexistuje - vytvářím výchozí konfiguraci (upravte: make menuconfig)"; bash scripts/menuconfig.sh --defaults; }

build: clients ## Sestaví klientské knihovny a Docker image
	$(COMPOSE) build

clients: ## Vygeneruje klientské knihovny z api/spec.json a zabalí balíčky (dist/)
	@node tools/build.js

image: build ## Alias pro build

up: envfile ## Spustí web backend v Dockeru (na pozadí)
	@mkdir -p $(RR_DATA_PATH)
	$(COMPOSE) up -d --build
	@echo "RR Registry běží: http://localhost:$(RR_PORT)/  (administrace /admin/)"

start: up ## Alias pro up

down: ## Zastaví a odstraní kontejner
	$(COMPOSE) down

stop: down ## Alias pro down

restart: envfile ## Restartuje kontejner (načte novou konfiguraci)
	$(COMPOSE) up -d --force-recreate

logs: ## Sleduje logy kontejneru
	$(COMPOSE) logs -f --tail=100

ps: ## Stav kontejneru
	$(COMPOSE) ps

status: ## Stav serveru přes API
	@curl -fsS http://localhost:$(RR_PORT)/api/v1/status || echo "server neběží na portu $(RR_PORT)"

shell: ## Shell uvnitř kontejneru
	$(COMPOSE) exec rr-registry sh

run: envfile clients ## Spustí server lokálně bez Dockeru (Node.js >= 18)
	node server/bin/rr-server.js

dev: run ## Alias pro run

test: test-unit test-e2e ## Spustí všechny testy (unit + integrační + e2e)

test-unit: ## Unit a integrační testy (node --test)
	node --test tests/*.test.js

test-e2e: clients ## End-to-end testy se skutečným npm a bash klienty
	bash scripts/test.sh

test-docker: ## Smoke test Docker image
	bash scripts/test.sh --docker

update: ## Aktualizace (záloha dat, git pull, rebuild, restart)
	bash scripts/update.sh

install: ## Instalace (kontrola závislostí, konfigurace, start)
	bash scripts/install.sh

uninstall: ## Odinstalace (zastaví kontejner, data ponechá)
	bash scripts/uninstall.sh

backup: ## Záloha dat registru do backups/
	bash scripts/backup.sh

restore: ## Obnova dat ze zálohy: make restore FILE=backups/....tar.gz
	bash scripts/backup.sh --restore "$(FILE)"

clean: ## Smaže vygenerované soubory (dist/)
	rm -rf dist

distclean: clean ## Smaže i data a konfiguraci (POZOR!)
	@read -p "Opravdu smazat $(RR_DATA_PATH) a .env? [y/N] " a; [ "$$a" = "y" ] && rm -rf $(RR_DATA_PATH) .env || echo zrušeno
