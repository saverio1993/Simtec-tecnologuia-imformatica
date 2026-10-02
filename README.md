# SIMTEC – Tecnología Informática

App web para el local de servicio técnico. Es una sola página: se abre `index.html` en el navegador (PC o celular) y funciona sin internet.

**Acceso inicial:** usuario `admin` · contraseña `simtec` (cámbiela en ⚙ Ajustes).

## Secciones

| Sección | Qué hace |
|---|---|
| **Clientes** | Crear cliente (Nombre, Tienda, WhatsApp) → Guardar. Buscar, editar, borrar y escribir por WhatsApp. |
| **Cartera** | Lista de quién debe. Abonos (se suman al reporte diario), recordatorio de cobro por WhatsApp y botón **Abrir en Excel**. |
| **Estadística** | Ranking animado de clientes, del que más trabajos trae (o más consume) al que menos. |
| **Reporte diario** | Ingresos y gastos del día, con acumulado y total al final. Exporta el día o todo a Excel. |
| **Factura DGI** | Abre el portal web de facturación de la DGI (el enlace se cambia en Ajustes). |
| **Orden de ingreso** | Plantilla de servicio técnico (equipo, IMEI, falla, costo, abono…). Imprime o guarda en PDF y la envía por WhatsApp. El saldo pasa solo a Cartera. |
| **Inventario** | Producto y cantidad, con botones + / −, alerta de agotados y exportación a Excel. |

## Datos

Los datos se guardan en el navegador del equipo donde se usa. En **Ajustes** se puede descargar una copia de seguridad (`.json`), restaurarla en otro equipo o exportar todo a un Excel con varias hojas.

> El usuario y la contraseña protegen la pantalla, pero los datos no están cifrados. No es un sistema multiusuario en línea.

## Estructura

```
index.html        pantalla de acceso + contenedor de la app
css/styles.css    estilo (negro, bordes blancos, colores del logo)
js/app.js         toda la lógica
assets/           logo y botones del menú
fonts/            fuentes Anton y Roboto Condensed (locales)
vendor/           SheetJS para generar archivos de Excel
```
