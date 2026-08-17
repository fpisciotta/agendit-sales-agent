# Agendit Sales Agent

Agente de ventas de WhatsApp con IA, en NestJS. Es la traducción del AgentKit
original (Python/FastAPI) con la misma arquitectura de providers, memoria y
derivación a humano, más soporte de coexistencia y plantillas.

## Arquitectura

```
src/
├── main.ts                  ← Bootstrap
├── app.module.ts            ← Módulo raíz + config de base de datos
├── config/
│   ├── agent-config.module.ts
│   └── prompts-config.service.ts   ← Lee config/prompts.yaml y business.yaml
├── brain/
│   └── brain.service.ts     ← Claude API (@anthropic-ai/sdk)
├── memory/
│   ├── memory.service.ts    ← Historial, derivaciones, leads
│   └── entities/            ← Mensaje, Derivacion, LeadPublicidad (TypeORM)
├── providers/
│   ├── whatsapp-provider.interface.ts  ← Contrato común
│   ├── meta.provider.ts     ← Meta Cloud API + coexistencia + plantillas
│   └── providers.module.ts  ← Factory
├── webhook/
│   ├── webhook.controller.ts ← GET /webhook (verificación), POST /webhook
│   └── webhook.service.ts   ← Orquesta el flujo de un mensaje
└── tests/
    └── chat-local.ts        ← Chat en terminal, sin WhatsApp
```

### Flujo de un mensaje

```
WhatsApp → POST /webhook → MetaProvider.parsearWebhook()
  → WebhookService: comandos #on/#off, filtro de leads, ¿derivada?
  → MemoryService.obtenerHistorial()
  → BrainService.generarRespuesta()  (Claude)
  → MetaProvider.enviarMensaje()
```

## Puesta en marcha

```bash
npm install
cp env.example .env    # completá las variables
npm run start:dev
```

Probar sin WhatsApp:

```bash
npm run test:local
```

## Variables de entorno

Están todas documentadas en `env.example`. Las mínimas para arrancar:

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | Claude |
| `META_ACCESS_TOKEN` | System User token de Meta |
| `META_PHONE_NUMBER_ID` | ID del número (no el número) |
| `META_VERIFY_TOKEN` | El que pongas en el panel de Meta |

`ANTHROPIC_MODEL` por defecto es `claude-opus-5` y `ANTHROPIC_EFFORT` es `low`
— lo apropiado para chat de WhatsApp, donde importan la latencia y las
respuestas cortas. Subí el esfuerzo si el agente necesita razonar en varios
pasos.

## Webhook

En developers.facebook.com → tu app → WhatsApp → Configuración → Webhooks:

- **Callback URL**: `https://tu-dominio/webhook`
- **Verify token**: el mismo `META_VERIFY_TOKEN`
- **Campos**: `messages`, `statuses` y, si el número está en coexistencia,
  también `history`, `smb_app_state_sync`, `smb_message_echoes`

Después hay que enganchar la app a la WABA — configurar el panel no alcanza:

```bash
curl -X POST "https://graph.facebook.com/v25.0/TU_WABA_ID/subscribed_apps" -H "Authorization: Bearer TU_TOKEN"
```

## Coexistencia y derivación a humano

Cuando el número está en coexistencia (app WhatsApp Business + Cloud API),
Meta manda un eco de todo lo que sale del número por `smb_message_echoes`.
El agente lo usa para saber cuándo callarse:

- Respondés a mano desde el celular → el agente se pausa en esa conversación.
- Escribís `#on` (desde el celular o el cliente) → el agente vuelve a atender.
- `#off` desde el cliente → deriva a humano.
- El agente puede derivarse solo incluyendo `[DERIVAR_A_HUMANO]` en su
  respuesta; la marca se borra antes de enviar.

Los mensajes que envía el propio agente también vuelven como eco. Por eso
`MetaProvider` recuerda los `wamid` que envió: sin eso el agente se
auto-derivaría cada vez que responde.

## Plantillas

Única forma de escribir fuera de la ventana de 24 h. Header y body cuentan sus
variables por separado — mandar todas al body devuelve el error `132000`:

```ts
// Posicionales ({{1}}, {{2}})
await proveedor.enviarPlantilla('595972511222', 'ai_validation_low_balancev2', {
  parametrosHeader: ['Tu paquete se esta agotando'],
  parametros: ['9'],
  idioma: 'es',
});

// Nombradas ({{nombre}}, {{hora}})
await proveedor.enviarPlantilla('595972511222', 'recordatorio_cita', {
  parametros: { nombre: 'Fabrizio', hora: '15:30' },
});
```

## Cambiar de proveedor de IA

Hay dos abstracciones paralelas: `providers/` para WhatsApp y `ai/` para el
modelo. El `BrainService` no conoce ningún SDK — recibe un `ProveedorIA` y
listo. Cambiar de modelo es una variable de entorno:

```bash
AI_PROVIDER=gemini    # gemini-2.5-flash (por defecto)
AI_PROVIDER=claude    # claude-opus-5
```

Un valor no reconocido **corta el arranque** en vez de caer en un default.
Es a propósito: es mejor no levantar que atender clientes con el modelo
equivocado por un typo en el `.env`.

Para agregar un proveedor: implementá `ProveedorIA` (`nombre`, `modelo`,
`generar()`) y registralo en el factory de `ai/ai.module.ts`.

### Lo que la interfaz normaliza

Cada API se comporta distinto en los bordes, y eso queda encapsulado:

| | Claude | Gemini |
|---|---|---|
| Rol del asistente | `assistant` | `model` |
| Rechazo por políticas | `stop_reason: "refusal"` | `promptFeedback.blockReason` / `finishReason` |
| Control de razonamiento | `effort: low…max` | `thinkingConfig.thinkingLevel` |

En los dos casos un rechazo llega como **respuesta exitosa sin texto**, no
como error. Los adaptadores lo detectan y devuelven `rechazado: true`, así que
`BrainService` nunca lee un `content` vacío.

### Razonamiento en Gemini

La API cambió entre generaciones, y el provider soporta las dos formas:

- **`GEMINI_THINKING_LEVEL`** (`low` | `medium` | `high`) — la de los 3.x. Es
  lo que hay que usar; `low` es lo apropiado para chat de WhatsApp.
- **`GEMINI_THINKING_BUDGET`** (tokens, o `-1` dinámico) — la forma vieja.

Sin ninguna de las dos definida no se manda `thinkingConfig` y el modelo
decide.

**`GEMINI_THINKING_BUDGET=0` desactivaba el razonamiento en los Gemini 2.5,
pero los 3.x razonan siempre y devuelven `400 INVALID_ARGUMENT`.** El provider
lo detecta, lo ignora y avisa por log en vez de dejar que rompa cada request.

Para diagnosticar un `400` de Gemini, `scripts/diag-gemini.mjs` prueba la
llamada por capas y te dice qué argumento se está rechazando:

```bash
node scripts/diag-gemini.mjs
```

También lista los modelos que acepta tu API key — útil porque un modelo puede
figurar en el listado y estar retirado (`gemini-2.5-flash` devuelve 404 hoy).

### `AI_MAX_TOKENS` y el razonamiento

**En los modelos que razonan, el techo de salida cubre thinking + respuesta.**
Si lo dejás corto, el modelo gasta el presupuesto razonando y lo que se emite
es la cola de su razonamiento en crudo: texto interno, a veces en inglés,
cortado a mitad de frase. Con `AI_MAX_TOKENS=1024` y razonamiento alto pasa
seguido.

El provider trata ese caso (`finishReason: MAX_TOKENS`) como fallo y devuelve
el mensaje de error en vez del texto truncado — mandarle el razonamiento del
modelo a un cliente es peor que no responder. Queda un `ERROR` en el log
diciendo qué subir.

El default es `3000`, que da margen para una respuesta de WhatsApp con
`GEMINI_THINKING_LEVEL=low`.

### Reintentos

Los modelos flash devuelven `503 "high demand"` en los picos, y el SDK de
Google no reintenta solo. `AI_INTENTOS` (3 por defecto) controla los intentos
totales; el backoff es exponencial con jitter de ±25 %, para que varias
conversaciones que fallaron juntas no vuelvan todas al mismo tiempo.

Se reintentan 408, 429 y 5xx, más los fallos de red. **No** se reintentan 400,
401, 403 ni 404: el pedido está mal y va a fallar igual.

El SDK de Anthropic ya trae reintentos propios, así que `ClaudeProvider`
traduce `AI_INTENTOS` a su `maxRetries` en vez de duplicar la lógica.

## Knowledge

`knowledge/` es material **fuente**, no se lee en runtime. El contenido
(planes, precios, funcionalidades, testimonios, contacto) ya está embebido
en el `system_prompt` de `config/prompts.yaml`, que es lo único que el
agente consulta.

Por eso, cuando cambian los precios o los planes hay que actualizar **los dos
lugares**: el `.md` de knowledge como registro legible, y el bloque
correspondiente de `config/prompts.yaml`, que es de donde el agente lee. Editar
solo el knowledge no cambia nada del comportamiento.

Si en algún momento querés que el agente busque en los archivos en vez de
llevar todo en el prompt, el camino es una tool de Claude que lea
`knowledge/` — no una función auxiliar suelta. El AgentKit original tenía un
`buscar_en_knowledge()` en `tools.py` que nunca se llamaba desde ningún
módulo; no se portó por eso.

## Deploy en EC2 con PM2

### 1. Dependencias del sistema

`better-sqlite3` compila código nativo al instalarse, así que el servidor
necesita toolchain. En Amazon Linux 2023:

```bash
sudo dnf install -y gcc-c++ make python3 git
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs
sudo npm install -g pm2
```

En Ubuntu es `apt install -y build-essential python3 git` y el equivalente de
NodeSource. Sin el compilador, `npm ci` falla con un error de `node-gyp` que no
menciona lo que falta.

### 2. Código y configuración

```bash
git clone <tu-repo> agendit-sales-agent && cd agendit-sales-agent
npm ci && npm run build
```

`.env.local` no está en git: copialo por `scp` o creá uno en el server con las
mismas variables. Verificá que `NODE_ENV=production`.

### 3. Arrancar

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # imprime un comando con sudo — ejecutalo para sobrevivir reinicios
```

`pm2 save` sin `pm2 startup` no alcanza: al reiniciar la instancia el agente
no vuelve solo.

### 4. HTTPS (obligatorio)

Meta **solo acepta webhooks HTTPS con certificado válido**. Necesitás un dominio
apuntando a la IP elástica de la instancia y nginx delante:

```nginx
server {
    server_name agentes.tudominio.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Después `sudo certbot --nginx -d agentes.tudominio.com` para el certificado.

En el Security Group abrí **80 y 443**, y dejá **8000 cerrado**: la app solo se
alcanza a través de nginx. Si exponés el 8000, cualquiera puede postear eventos
falsos al webhook.

La Callback URL en Meta queda `https://agentes.tudominio.com/webhook`, y esta vez
es fija — se termina el ciclo de reeditarla cada vez que reinicia ngrok.

### 5. Backup de la base

SQLite es un solo archivo y ahí vive todo: historial, derivaciones, leads y
recontactos. Un cron diario alcanza:

```bash
0 3 * * * sqlite3 /home/ec2-user/agendit-sales-agent/agendit-sales-agent.db ".backup '/home/ec2-user/backups/agente-$(date +\%F).db'"
```

Usá `.backup` y no `cp`: copiar el archivo con la app escribiendo puede dejarte
un backup corrupto.

### Comandos del día a día

```bash
pm2 logs agendit-sales-agent      # ver qué está pasando
pm2 restart agendit-sales-agent   # después de cambiar .env.local o el prompt
pm2 status
```

Ojo con el prompt: `config/prompts.yaml` se lee **una sola vez al arrancar**, así
que editarlo no tiene efecto hasta el `pm2 restart`.

## Notas de operación

- **`SOLO_LEADS_PUBLICIDAD=true`** (por defecto) hace que el agente responda
  solo a números que llegaron por Click-to-WhatsApp. Ponelo en `false` para
  probar desde tu celular, o no vas a recibir respuesta.
- **Aceptado no es entregado.** Un envío puede devolver `wamid` y no llegar
  nunca. Por eso el provider loguea el webhook de `statuses` con el código de
  error — sin eso los fallos de entrega desaparecen sin rastro.
- **En producción usá migraciones.** `synchronize` está activo solo fuera de
  producción; en una base con datos de clientes crea y modifica tablas sin
  control.
