# sm3.0-bytecode

# 1. PDHS CONTAINER FORMAT

0x00  4 bytes  "PDHS" magic\
0x04  4 bytes  version = 1 (uint32 LE)\
0x08  4 bytes  entry count\
0x0C  entries start, stacked back to back, no padding, no alignment, just vibes

Each entry is:

uint16 name_len\
name_len bytes ASCII name\
uint32 blob_size\
blob_size bytes raw blob

# 2. ENTRY TYPES

66 total entries\
43 = actual shader bytecode\
23 = parameter-table-only junk.

If the blob starts with 0x0109FFFE, that’s just a constant/register table. No DX9 shader inside. We skip. Not a shader. Don’t romanticize it.

Names with b_* or p_* usually fall into this category.

# 3. SUB-BLOB STRUCTURE

Inside shader blobs, you get mini-chunks separated like this:

FF FF FF FF\
uint32 kind\
uint32 zero (always 0, because consistency is rare but appreciated)\
uint32 size\
size bytes data

Observed kind values:

0 = VS\
1 = PS\
2 = FX/render-state blob\
7, 9, 12 = PS permutations\
8, 11 = big VS perms\
53–76 = render-state bindings, size 0, literally empty energy

We DO NOT trust kind blindly\
We detect real shaders via first 4 bytes of sub-blob:

00 03 FF FF -> PS SM3.0\
00 03 FE FF -> VS SM3.0\
Anything else -> not a shader, move along

# 4. SHADER RECONSTRUCTION

This container stores shaders in a cursed layout:

[version + CTAB comment]\
[main math/tex ops]\
[FF FF 00 00 ← fake end]\
[def/dcl instructions ← actual declarations]

DX9 requires def/dcl BEFORE arithmetic\
But here they’re shoved after a fake END token

Naive parser sees FF FF 00 00 and says “cool, we’re done.”\
Wrong. You just chopped off all constant/register declarations

Fix is surgical:

header = version + CTAB block\
main = instructions before fake end\
tail = everything after fake end

Rebuild like this:

output = header + tail + main + END_TOKEN

END_TOKEN = FF FF 00 00

Invariant across all 453 shaders:\
len(output) == len(original_blob)

# 5. FX / RENDER-STATE BLOBS

If sub-blob magic isn’t DX9 shader magic, it’s FX

Starts like:

00 02 58 46 → type 0x5846 (“XF”)

Not a FourCC

Real chunks inside can be:

CTAB -> constant table\
CLIT -> constant literal table\
FXLC -> render-state bytecode

fxc.exe refuses these because it only accepts shader types 0xFFFF (PS) and 0xFEFF (VS)

FXLC encodes render states like CullMode, blending, etc., in compact bytecode

# 6. USAGE

python extract_sm30.py [input] [outdir] [--dump-fx]

Output naming:

ps_<entry>*<i>.fxc\
vs*<entry>*<i>.fxc\
fx*<entry>_<i>_k<kind>.bin

7. SAMPLE DATA from fxc decompiler

```
// Params:
//
//   sampler2D diffMapSampler;
//
//
// Registers:
//
//   Name           Reg   Size
//   -------------- ----- ----
//   diffMapSampler s0       1
//
```

    ps_3_0
    dcl_texcoord v0.xy
    dcl_2d s0
    mov oC0.xyz, c0
    texld r0, v0, s0
    mov oC0.w, r0.w

prodbysimo 🖤\
base: February 22, 2026