// ecosystem.config.js — Configuración de PM2 para producción
//
// Uso:
//   npm ci && npm run build
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup     ← para que sobreviva un reinicio del servidor
//
// Ver logs:   pm2 logs agendit-sales-agent
// Reiniciar:  pm2 restart agendit-sales-agent
// Estado:     pm2 status

module.exports = {
  apps: [
    {
      name: 'agendit-sales-agent',
      script: 'dist/main.js',

      // El cwd tiene que ser la raíz del proyecto: desde acá se resuelven
      // config/prompts.yaml, .env.local y el archivo .db de SQLite.
      cwd: __dirname,

      /**
       * UNA SOLA INSTANCIA, y en modo fork — no cluster. No es una preferencia,
       * el agente se rompe de tres formas distintas con varios procesos:
       *
       * 1. SQLite es un archivo: varios procesos escribiendo a la vez se pisan
       *    y aparecen errores de "database is locked".
       *
       * 2. El cron de recontacto correría en cada instancia, así que el mismo
       *    cliente recibiría N mensajes en lugar de uno.
       *
       * 3. MetaProvider guarda en memoria los wamid que envió, para reconocer
       *    sus propios ecos de coexistencia. Con varias instancias, el eco de
       *    un mensaje enviado por el proceso A le llega al proceso B, que no lo
       *    reconoce, lo toma por una respuesta humana y deriva la conversación
       *    al equipo. El agente se silenciaría solo cada vez que responde.
       *
       * Si en algún momento hace falta escalar: mover SQLite a Postgres, sacar
       * el cron a un proceso aparte y compartir los wamid en un store común.
       */
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      // Si el proceso muere apenas arranca 10 veces seguidas, PM2 deja de
      // reintentar. Evita un loop de crash cuando falta una variable de entorno.
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 4000,

      // Un reinicio por fuga de memoria es preferible a que el server quede sin RAM.
      max_memory_restart: '500M',

      // No usar watch en producción: reiniciaría con cada escritura al .db
      watch: false,

      env: {
        NODE_ENV: 'production',
        PORT: 8000,
      },

      // Las claves NO van acá: viven en .env.local, que la app lee al arrancar
      // (ver ConfigModule en src/app.module.ts). Así no terminan en git.

      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: true, // timestamp en cada línea de log
    },
  ],
};
