# Guion de video — MarsGuard (aproximadamente 2 minutos)

Este guion acompaña una grabación real de la interfaz. No describe un video ya producido: hay que ejecutar la aplicación y registrar la pantalla mientras se dicen estas ideas.

Antes de grabar:

```bash
npm install
npm run dev
```

Abrir `http://localhost:3000`. Dejar visible el monitor del Circuit Breaker, los contadores y el registro de eventos. Si la ventana es baja, reducir el zoom del navegador hasta que quepan el monitor y la consola.

## 0:00 – 0:15 · Qué es MarsGuard

Mostrar el encabezado, con el nombre MARS/GUARD y la misión ARES-01.

Decir: MarsGuard es un centro de control que consulta la telemetría de un rover. Hay dos servicios separados. La pantalla habla solo con Mission Control. Mission Control es quien llama al rover.

## 0:15 – 0:30 · Qué problema resuelve el Circuit Breaker

Señalar el monitor, todavía en CLOSED.

Decir: si el servicio remoto falla y el centro sigue llamándolo en cada consulta, cada operador espera un error o un timeout. El Circuit Breaker corta esas llamadas cuando los fallos se repiten, conserva la última lectura válida y vuelve a probar la conexión por su cuenta.

## 0:30 – 0:45 · Funcionamiento normal

Pulsar **Consultar telemetría**.

Mostrar que la batería, la temperatura, la señal, la velocidad y las coordenadas cambian, y que el registro dice «Telemetría recibida correctamente». El estado sigue en CLOSED. Señalar que «Solicitudes al servicio remoto» aumentó: la llamada sí salió.

## 0:45 – 1:05 · Simulación de fallos

Pulsar **Simular pérdida de comunicación**.

Pulsar **Consultar telemetría** tres veces, despacio, para que se lean los eventos.

Decir: el rover responde HTTP 503. El primer fallo deja el circuito cerrado, el segundo también. Al tercero el contador llega a 3/3 y el estado pasa a OPEN.

## 1:05 – 1:25 · Apertura y bloqueo

Con el circuito en OPEN, pulsar otra vez **Consultar telemetría**.

Señalar tres cosas a la vez:

- la respuesta fue inmediata;
- «Solicitudes bloqueadas» subió y «Solicitudes al servicio remoto» no;
- el panel marca los datos como desactualizados y muestra la hora de la última lectura válida.

Decir: esa consulta no llegó al rover. El centro responde con lo último que sí recibió, sin inventar una medición nueva.

## 1:25 – 1:45 · Recuperación por HALF_OPEN

Pulsar **Restaurar comunicación**.

Decir: este botón solo revive al rover. No cierra el circuito a mano. La cuenta regresiva de ocho segundos empezó cuando el circuito se abrió; en pantalla se ve el tiempo que falta.

Cuando el contador llegue a cero, mostrar que el estado pasa a HALF_OPEN. Pulsar **Consultar telemetría** una vez.

Decir: esa es la única consulta de prueba. Si el rover responde, el circuito vuelve a CLOSED y la telemetría queda otra vez marcada como lectura en vivo.

## 1:45 – 2:00 · Cierre

Opcional, si queda tiempo: pulsar **Simular respuesta lenta** y una consulta. Explicar que el rover tarda unos tres segundos, pero el circuito abandona la espera al segundo y medio y ese timeout también cuenta como fallo.

Cerrar con esta idea: el patrón no repara el enlace. Evita que un servicio inestable arrastre al centro de control, y deja una vía explícita para comprobar cuándo se puede confiar de nuevo en él.

Pulsar **Reiniciar demostración** solo si se va a repetir la toma. No hace falta mostrarlo si el relato ya cerró en CLOSED.
