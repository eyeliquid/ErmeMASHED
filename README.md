# ErmeMASHED

3D combat racer gebaseerd op het Mashed-gamedesigndocument. Speel samen in een lobby met tot 6 spelers; zijn jullie met minder dan 4, dan vullen bots aan tot 4 auto's. Alles draait in Docker:

| Container     | Wat het doet                                                               |
| ------------- | -------------------------------------------------------------------------- |
| `frontend`    | nginx: serveert de game (3D via Three.js) en stuurt `/api` en `/ws` door    |
| `backend`     | Node.js: lobby's via WebSocket (max 6 spelers per potje) en scorebord       |
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
# open .env en vervang <plak-hier-je-cloudflare-tunnel-token> door je token
docker compose up -d --build
```

In `.env.example` staan alleen placeholders; je echte token zet je uitsluitend in `.env`. Dat bestand staat in `.gitignore` en komt dus niet op GitHub. Staat de placeholder er nog in, dan kan de `tunnel`-container niet verbinden en blijft hij opnieuw opstarten (`docker compose logs tunnel`).

- Online: https://ermemashed.terpstack.dev
- Lokaal: http://localhost:8080
- Controleren of de tunnel verbonden is: `docker compose ps` (de `tunnel` moet *healthy* zijn) of `docker compose logs tunnel`.

## Zo werkt het spel

1. **Startscherm:** vul je nickname in.
2. **Lobby's:** kies een open lobby en klik op *Meedoen*, of maak er zelf een aan. Zonder verbinding met de server kun je offline tegen bots spelen.
3. **Lobby:** maximaal 6 spelers. De maker is host en kiest de modus (Battle of Race), de baan, het niveau van de bots en de puntendrempel. Zijn jullie met minder dan 4, dan rijden er bots mee tot er 4 auto's starten.
4. **Spelen:** de host start het potje. Na afloop kan de host nog een potje starten of iedereen terugsturen naar de lobby.

De browser van de host rekent het spel uit (ook de bots) en stuurt ~20 keer per seconde de stand naar de anderen. Je eigen auto reageert direct; bij botsingen en treffers volgt hij de host. Gaat de host weg, dan wordt de volgende speler host en gaat iedereen terug naar de lobby. Houd als host het tabblad open: een browser zet de game op de achtergrond bijna stil.

In Battle delen alle spelers één camera, net als op één scherm: wie uit beeld raakt, ligt eruit. Het kader is ruim, de camera blijft dicht bij het midden van het veld en je mag heel even over de rand gaan voordat je eruit ligt.

Is er nog één auto over, dan volgt een korte cutscene: de camera draait rond de auto van de winnaar, en links verschijnt de tussenstand waarin de nieuwe punten erbij komen (+2, +1, 0 of −1).

### 3D

De game wordt in 3D getekend met [Three.js](https://threejs.org) (r159). De camera hangt schuin achter de actie en draait mee met de baan, zoals in Mashed. De spelregels en de natuurkunde zijn 2D gebleven; alleen de weergave is 3D. Three.js wordt tijdens `docker compose build` uit npm gehaald en staat niet in de repository. Heeft een browser geen WebGL, dan valt de game terug op een 2D-weergave van bovenaf.

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
  public/index.html de game zelf (één bestand); Three.js komt er bij het bouwen bij
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
| WS      | `/ws`                           | Lobby's: `hello`, `create`, `join`, `start`, input en snapshots |

Het scorebord staat in het Docker-volume `scores` (bestand `/data/scores.json`). Per naam wordt per baan de beste ronde bewaard.
