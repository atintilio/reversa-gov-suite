// Animacao de fundo (WebGL) da marca Reversa.
// Mesma onda do painel lateral do login, reusada como faixa no topo da
// pagina de escolha de suite. Se o navegador nao tiver WebGL, a pagina
// mantem o degrade de fundo em CSS e nada quebra.
(function () {
  var cv = document.getElementById('fundo'); if (!cv) return;
  var gl = cv.getContext('webgl', { antialias: false, premultipliedAlpha: false }); if (!gl) return;
  var vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var fs = [
    'precision highp float;uniform vec2 r;uniform float t;uniform float esc;',
    'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}',
    // esc > 1 recorta a onda: a faixa e larga e mostra uma fatia horizontal
    // do mesmo material, sem esticar (e sem apagar a vinheta nas pontas).
    'void main(){vec2 uv=(gl_FragCoord.xy-.5*r)/(min(r.x,r.y)*esc);float s=t*.06;',
    'vec2 q=vec2(fbm(uv*1.6+s),fbm(uv*1.6-s+4.1));',
    'vec2 w=vec2(fbm(uv*1.4+2.2*q+vec2(1.7,9.2)+s*1.4),fbm(uv*1.4+2.2*q+vec2(8.3,2.8)-s));',
    'float f=fbm(uv*1.2+2.6*w);',
    'float e=.004;float fx=fbm((uv+vec2(e,0))*1.2+2.6*w)-f;float fy=fbm((uv+vec2(0,e))*1.2+2.6*w)-f;',
    'vec3 nr=normalize(vec3(-fx*90.,-fy*90.,1.));float spec=pow(max(dot(reflect(vec3(0,0,-1),nr),normalize(vec3(-.4,.6,.7))),0.),18.);',
    'vec3 navy=vec3(.024,.07,.122),deep=vec3(.055,.133,.224),teal=vec3(.118,.561,.533),mint=vec3(.56,.88,.85),cobre=vec3(.78,.5,.33);',
    'vec3 c=mix(navy,deep,smoothstep(.2,.5,f));c=mix(c,teal,smoothstep(.45,.8,f)*.85);',
    'c=mix(c,cobre,smoothstep(.62,.9,w.y)*smoothstep(.5,.75,f)*.55);',
    'c+=mint*spec*.55+vec3(1.)*pow(spec,4.)*.35;',
    'c*=1.-.35*length(uv*.8);gl_FragColor=vec4(c,1.);}'
  ].join('\n');
  function sh(tipo, src) { var o = gl.createShader(tipo); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; }
  var a = sh(gl.VERTEX_SHADER, vs), b = sh(gl.FRAGMENT_SHADER, fs); if (!a || !b) return;
  var pr = gl.createProgram(); gl.attachShader(pr, a); gl.attachShader(pr, b); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uR = gl.getUniformLocation(pr, 'r'), uT = gl.getUniformLocation(pr, 't'), uE = gl.getUniformLocation(pr, 'esc');
  var escala = parseFloat(cv.getAttribute('data-escala') || '1') || 1;
  var parado = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches, t0 = performance.now();
  function tam() { var d = Math.min(window.devicePixelRatio || 1, 1.5), w = cv.clientWidth * d | 0, hh = cv.clientHeight * d | 0; if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; gl.viewport(0, 0, w, hh); } }
  function quadro(agora) {
    tam(); gl.uniform2f(uR, cv.width, cv.height); gl.uniform1f(uT, parado ? 12 : (agora - t0) / 1000 + 12); gl.uniform1f(uE, escala);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!parado && !document.hidden) requestAnimationFrame(quadro);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !parado) requestAnimationFrame(quadro); });
  window.addEventListener('resize', function () { if (parado) quadro(0); });
  requestAnimationFrame(quadro);
})();
