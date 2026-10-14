# ErmeMASHED

Top-down combat racer voor 4 auto's, gebaseerd op het Mashed-gamedesigndocument. Alles draait in Docker:

| Container     | Wat het doet                                                               |
| ------------- | -------------------------------------------------------------------------- |
| `frontend`    | nginx: serveert de game en stuurt `/api` en `/ws` door naar de backend      |
| `backend`     | Node.js: online rijden via WebSocket (tot 20 spelers per baan) en scorebord |
| `tunnel`      | Cloudflare-tunnel naar **https://ermemashed.terpstack.dev** (standaard)      |
| `quicktunnel` | Alternatief: tijdelijke link op trycloudflare.com, zonder token             |

Je hebt alleen Docker nodig (Docker Desktop, of Docker Engine met Compose v2). Er hoeft niets anders op je computer te staan.

## Eenmalig: de tunnel in Cloudflare aanmaken

Het domein `terpstack.dev` moet in je Cloudflare-account staan.

1. Ga in het Cloudflare-dashboard naar **Zero Trust → Networks → Tunnels** en maak een tunnel van het type *Cloudflared*, bijvoorbeeld met de naam `ermemashed`.
2. Kies bij de installatie **Docker** en kopieer het token: de lange tekst na `--token`. Het commando zelf hoef je niet uit te voeren.
3. Voeg bij de tunnel een **public hostname** toe:
   - Subdomain: `ermemashed`
   - Domain: `terpstack.dev`
   - Service type: **HTTP**
   - URL: **`frontend:80`**

   Cloudflare maakt het DNS-record `ermemashed.terpstack.dev` dan zelf aan.

## Starten

```bash
cp .env.example .env
# zet het token achter CLOUDFLARE_TUNNEL_TOKEN= in .env
docker compose up -d --build
```

- Online: https://ermemashed.terpstack.dev
- Lokaal: http://localhost:8080
- Controleren of de tunnel verbonden is: `docker compose ps` (de `tunnel` moet *healthy* zijn) of `docker compose logs tunnel`.

Bij het openen van de game vul je eerst je naam in. Die naam staat boven je auto, in de online stand en op het scorebord.

### Zonder token even testen

Zet in `.env` `COMPOSE_PROFILES=quick` en start met `docker compose up -d --remove-orphans`. Je krijgt dan een tijdelijke link op trycloudflare.com. Die staat in het menu van de game en in `docker compose logs quicktunnel`.

WebSockets (online rijden) werken via Cloudflare zonder extra instellingen.

## Handige commando's

```bash
docker compose ps                  # draait alles?
docker compose logs -f backend     # wie komt er online binnen
docker compose down                # stoppen (scorebord blijft bewaard)
docker compose down -v             # stoppen en het scorebord wissen
docker compose up -d --build       # opnieuw bouwen na een wijziging in de code
```

Wil je een andere lokale poort, zet dan `HTTP_PORT` in `.env`.

## Mappen

```
docker-compose.yml
.env.example
frontend/
  Dockerfile        nginx:1.27-alpine
  nginx.conf        /api en /ws naar de backend, de rest is de game
  public/index.html de game zelf (één bestand)
backend/
  Dockerfile        node:22-alpine
  server.js         WebSocket-rooms + REST-API
  package.json      enige dependency: ws
```

## Backend-API

| Methode | Pad                             | Doel                                                       |
| ------- | ------------------------------- | ---------------------------------------------------------- |
| GET     | `/api/health`                   | Status en aantal spelers online                            |
| GET     | `/api/leaderboard?track=polar`  | Top 10 snelste rondes (`polar`, `angel`, `ventura`)        |
| POST    | `/api/laps`                     | Rondetijd opslaan: `{ "name", "track", "time" }`           |
| GET     | `/api/share`                    | Publieke link van de tunnel                                |
| WS      | `/ws`                           | Online rijden: `join` een baan, daarna status-updates      |

Het scorebord staat in het Docker-volume `scores` (bestand `/data/scores.json`). Per naam wordt per baan de beste ronde bewaard.
