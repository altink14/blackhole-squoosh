export const VERTEX_SHADER = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;      // wall clock, drives twinkle + drift
uniform float uPhase;     // integrated disk rotation, immune to speed changes
uniform float uIntensity; // 0 = idle, 1 = feeding
uniform int   uSteps;     // geodesic integration budget

// Schwarzschild radius is 1.0, so: horizon = 1.0, photon sphere = 1.5, ISCO = 3.0
#define DISK_IN  3.00
#define DISK_OUT 11.0

// ---------------------------------------------------------------- hashing --

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// ------------------------------------------------------------------ noise --

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise2(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise3(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

// ------------------------------------------------------------- background --

vec3 starField(vec3 dir) {
  vec3 col = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float scale = 55.0 + fk * 85.0;
    vec3 p = dir * scale;
    vec3 ip = floor(p);
    vec3 fp = fract(p) - 0.5;
    float h = hash13(ip + fk * 17.13);
    if (h > 0.905) {
      vec3 off = vec3(
        hash13(ip + 1.37), hash13(ip + 2.71), hash13(ip + 4.19)
      ) - 0.5;
      float d = length(fp - off * 0.7);
      float core = smoothstep(0.17, 0.0, d);
      float twinkle = 0.72 + 0.28 * sin(uTime * 1.6 + h * 91.0);
      vec3 tint = mix(
        vec3(0.62, 0.76, 1.0), vec3(1.0, 0.85, 0.66), hash13(ip + 9.91)
      );
      col += tint * core * core * twinkle * (0.5 + 1.1 * fract(h * 37.0));
    }
  }
  return col;
}

vec3 nebula(vec3 dir) {
  float n = fbm3(dir * 2.1 + 3.7);
  float m = fbm3(dir * 4.6 - 1.9);
  vec3 tint = mix(vec3(0.020, 0.028, 0.075), vec3(0.075, 0.024, 0.115), m);
  return tint * smoothstep(0.34, 1.0, n) * 1.15;
}

// -------------------------------------------------------- accretion disk --

// Returns premultiplied emission in .rgb and opacity in .a
vec4 sampleDisk(vec3 p, vec3 rd) {
  float r = length(p.xz);
  float t = (r - DISK_IN) / (DISK_OUT - DISK_IN);

  // Rigid rotation plus a bounded travelling wave in radius.
  //
  // True Keplerian shear (uPhase * k * r^-1.5) is tempting and looks right for
  // the first few seconds, but its radial gradient grows linearly with elapsed
  // time. After a minute adjacent radii differ by radians of rotation and the
  // disk collapses into concentric rings. Keeping the differential term bounded
  // preserves the swirl and never degenerates.
  // The spiral arms come from a STATIC log twist, so they rotate rigidly and
  // stay coherent. Only a small bounded term varies with both radius and time.
  // Total differential across the disk has to stay near a radian -- beyond that
  // any radius-dependent rotation smears isotropic noise into concentric rings.
  float twist = 1.15 * log(r / DISK_IN + 0.6);
  float spin = uPhase * 0.5 + twist + 0.3 * sin(uPhase * 0.15 - r * 0.2);
  float cs = cos(spin);
  float sn = sin(spin);
  vec2 q = mat2(cs, -sn, sn, cs) * p.xz;

  float n1 = fbm2(q * 0.52 + vec2(0.0, uPhase * 0.05));
  float n2 = fbm2(q * 1.85 - 7.31);
  float dens = n1 * 0.78 + n2 * 0.34;
  // A high threshold keeps the disk filamentary. A low one turns it into a
  // solid sheet, which washes grey over the shadow every time a ray clips it
  // on the way to the horizon.
  dens = smoothstep(0.44, 0.96, dens);

  // Fade in off the inner edge, feather out into the void.
  float env = smoothstep(0.0, 0.09, t) * (1.0 - smoothstep(0.45, 1.0, t));
  dens *= env;
  if (dens <= 0.001) return vec4(0.0);

  // Temperature ramp: white-hot at the ISCO, cooling outward.
  vec3 col = mix(vec3(1.00, 0.97, 0.93), vec3(1.00, 0.70, 0.32),
                 smoothstep(0.0, 0.22, t));
  col = mix(col, vec3(0.94, 0.31, 0.09), smoothstep(0.20, 0.56, t));
  col = mix(col, vec3(0.38, 0.09, 0.16), smoothstep(0.56, 1.0, t));

  float emission = 1.75 / (0.34 + r * 0.27);

  // Relativistic beaming: the side rotating toward us is dramatically brighter.
  vec3 vdir = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(p.x, 0.0, p.z)));
  float beta = clamp(0.84 / sqrt(max(r, 1.5)), 0.0, 0.72);
  float mu = dot(vdir, -rd);
  float doppler = 1.0 / max(1.0 - beta * mu, 0.13);
  float beam = pow(doppler, 2.6);

  // Gravitational redshift dims material deep in the well.
  float grav = sqrt(max(1.0 - 1.0 / max(r, 1.02), 0.0));

  float gain = emission * beam * grav * (0.85 + 0.95 * uIntensity);
  return vec4(col * gain * dens, clamp(dens * 0.92, 0.0, 1.0));
}

// ------------------------------------------------------------ tonemapping --

vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// -------------------------------------------------------------------- main --

void main() {
  vec2 frag = gl_FragCoord.xy;
  // Normalise by the SHORT edge. Dividing by height alone frames the hole
  // correctly in landscape but blows it up past the edges of a portrait phone,
  // where the height is the long side.
  vec2 uv = (frag - 0.5 * uResolution) / min(uResolution.x, uResolution.y);

  // Fixed camera, just above the disk plane. No pointer tracking by design;
  // a barely-there drift keeps it from reading as a still image.
  vec3 ro = vec3(0.0, 2.85 + sin(uTime * 0.11) * 0.10, -27.0);
  vec3 ww = normalize(vec3(0.0, 0.0, 0.0) - ro);
  vec3 uu = normalize(cross(vec3(0.0, 1.0, 0.0), ww));
  vec3 vv = cross(ww, uu);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.55 * ww);

  vec3 pos = ro;
  vec3 dir = rd;

  // Conserved specific angular momentum drives the deflection term.
  vec3 hvec = cross(pos, dir);
  float h2 = dot(hvec, hvec);

  vec3 col = vec3(0.0);
  float transmit = 1.0;
  bool captured = false;
  float jitter = hash12(frag + fract(uTime) * 149.0);

  for (int i = 0; i < 400; i++) {
    if (i >= uSteps) break;

    float r2 = dot(pos, pos);
    float r = sqrt(r2);

    if (r < 1.0) { captured = true; break; }
    if (r > 44.0 && dot(pos, dir) > 0.0) break;

    float dt = clamp(0.055 * r, 0.045, 0.85);
    if (i == 0) dt *= 0.45 + 0.55 * jitter; // dither away the stepping bands

    // a = -3/2 h^2 r / |r|^5  (null geodesic in Schwarzschild, GM = c = 1)
    vec3 acc = -1.5 * h2 * pos / (r2 * r2 * r);
    vec3 npos = pos + dir * dt + 0.5 * acc * dt * dt;
    vec3 ndir = normalize(dir + acc * dt);

    // Crossing the equatorial plane means we hit the disk. A single ray can
    // cross several times, which is what produces the lensed arcs above and
    // below the shadow.
    if (pos.y * npos.y < 0.0) {
      float f = pos.y / (pos.y - npos.y);
      vec3 hit = mix(pos, npos, f);
      float hr = length(hit.xz);
      if (hr > DISK_IN && hr < DISK_OUT) {
        vec4 s = sampleDisk(hit, normalize(npos - pos));
        col += s.rgb * transmit;
        transmit *= 1.0 - s.a;
      }
    }

    pos = npos;
    dir = ndir;
    if (transmit < 0.004) break;
  }

  if (!captured && transmit > 0.004) {
    vec3 d = normalize(dir);
    col += (starField(d) + nebula(d)) * transmit;
  }

  // Cheap standing glow hugging the photon ring, in lieu of a bloom pass.
  float b = length(cross(ro, rd));
  // Cut the glow off hard at the critical impact parameter. Nothing escapes
  // from inside the shadow, so any bleed there reads as a washed-out smudge.
  float halo = exp(-pow(max(b - 2.6, 0.0) * 0.52, 1.35))
             * smoothstep(2.36, 2.62, b);
  col += vec3(1.0, 0.54, 0.22) * halo * 0.15 * (0.75 + 0.7 * uIntensity);

  col = aces(col * 1.02);
  col = pow(col, vec3(1.0 / 2.2));

  // Slight vignette, then dither to kill 8-bit banding in the dark falloff.
  col *= 1.0 - 0.28 * dot(uv, uv);
  col += (hash12(frag * 1.37) - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}
`;
