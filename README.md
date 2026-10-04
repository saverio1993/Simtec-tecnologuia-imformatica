# SIMTEC – Tecnología Informática

App web para el local de servicio técnico, publicada en Vercel. Los datos se guardan en la nube (Vercel Blob privado) y se ven iguales en todas las computadoras y celulares donde se entre con el usuario.

**Acceso inicial:** usuario `admin` · contraseña `simtec` (cámbiela en ⚙ Ajustes).

## Secciones

| Sección | Qué hace |
|---|---|
| **Clientes** | Crear cliente (Nombre, Tienda, WhatsApp) → Guardar. Buscar, editar, borrar y escribir por WhatsApp. |
| **Cartera** | Lista de quién debe. Abonos (se suman al reporte diario), recordatorio de cobro por WhatsApp y botón **Abrir en Excel**. |
| **Estadística** | Ranking animado de clientes, del que más trabajos trae (o más consume) al que menos. |
| **Reporte diario** | Ingresos y gastos del día, con acumulado y total al final. Exporta el día o todo a Excel. |
| **Factura DGI** | Abre el portal web de facturación de la DGI (el enlace se cambia en Ajustes). |
| **Orden de ingreso** | Plantilla simple: cliente, equipo, marca (botones) y modelo (lista de los más comunes), falla con botones (FRP, KG, PayJoy, Software, Cuenta Mi u otra), nota opcional, costo y abono. La fecha es la de hoy. El comprobante tiene el formato de hoja de orden de servicio (marca, modelo, IMEI, diagnóstico, SIM/memoria/batería, abono/debe/total, garantía, firma). Imprime o guarda en PDF y la envía por WhatsApp. El saldo pasa solo a Cartera. Cada orden tiene **etiqueta naranja con código QR** (60 × 30 mm: QR, cliente, modelo y falla, logo de fondo) para pegar en el equipo; con **📷 Escanear** (cámara o lector USB) se marca *Listo* (y se avisa por WhatsApp) o *Entregado* (cobrando el saldo). Filtro En taller / Listos / Entregados. |
| **Inventario** | Producto y cantidad, con botones + / −, alerta de agotados y exportación a Excel. |

## Instalar como aplicación

Es una PWA (`manifest.webmanifest` + `sw.js`): en Chrome/Edge de PC o en Chrome de Android aparece el botón **📲 Instalar** (o en el menú ⋮ → *Instalar SIMTEC* / *Agregar a la pantalla principal*). Queda un ícono con el logo y abre en su propia ventana. En iPhone: Safari → Compartir → *Agregar a inicio*.

## Datos

- Cada cambio se guarda solo en la nube (indicador **☁ Guardado** arriba). Si se cae el internet, se guarda en el navegador y se sube al volver.
- Las otras computadoras ven los cambios al cambiar de sección o en máximo 20 segundos.
- Cada día se guarda una copia de seguridad automática en la nube (`simtec/copias/AAAA-MM-DD.json` en el Blob store `simtec-datos`).
- **⬇ Descargar Excel** en cada sección (o **Descargar todo en Excel** en Ajustes) baja los datos a la PC.
- El usuario y la contraseña los valida el servidor; al cambiarlos se cierran las demás sesiones.

## Servidor (`/api`)

| Ruta | Qué hace |
|---|---|
| `POST /api/login` | Usuario y contraseña → sesión de 30 días |
| `GET /api/data` | Trae todos los datos |
| `POST /api/data` | Guarda los cambios (solo lo que cambió) o reemplaza todo al restaurar una copia |
| `POST /api/password` | Cambia usuario y contraseña |

Necesita la variable `BLOB_READ_WRITE_TOKEN` (ya configurada al conectar el Blob store al proyecto).

Para probar en local sin Vercel: `npm install && npm run dev` (guarda en `datos-local.json`, puerto 3000).

## Estructura

```
index.html        pantalla de acceso + contenedor de la app
css/styles.css    estilo (negro, bordes blancos, colores del logo)
js/app.js         toda la lógica de la pantalla y la sincronización
api/              servidor en Vercel (login, datos, contraseña)
scripts/          servidor local de pruebas
assets/           logo y botones del menú
fonts/            fuentes Anton y Roboto Condensed (locales)
vendor/           SheetJS (Excel), qrcode-generator (crear QR) y jsQR (leer QR con la cámara)
```

## Publicar una versión nueva

Al cambiar la página, subir el mismo número de versión en `version.json`, en `APP_VERSION` de `js/app.js` y en los `?v=` de `index.html`. Las pantallas abiertas muestran un aviso para actualizar.
