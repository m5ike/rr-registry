# @m5ike/rr_bash-gui — `rr-gui`

Textové „grafické" menu (whiptail / dialog) pro kompletní správu **RR Registry**:
připojení a přihlášení, repozitáře, balíčky, prohlížení souborů, směrovací pravidla,
cache, uživatelé, tokeny, nastavení, logy. Všechna volání jdou přes generovanou
knihovnu `lib/rr-api.sh`. Maintainer: **m5ike**.

Závislosti: `bash ≥ 4`, `curl`, `jq`, `whiptail` nebo `dialog`
(Debian/Ubuntu: `apt install whiptail jq`, macOS: `brew install newt jq`).

## Instalace a spuštění

```bash
curl -fsSL http://localhost:4873/install.sh | bash -s -- rr_bash-gui
rr-gui
```

Konfigurace se sdílí s `rr` (`~/.config/rr/config`), proměnná `RR_DIALOG=dialog` vynutí `dialog`.
