import struct, os, sys

PDHS_MAGIC = b'PDHS'
PS_MAGIC   = bytes([0x00, 0x03, 0xFF, 0xFF])   # SM3.0 pixel shader
VS_MAGIC   = bytes([0x00, 0x03, 0xFE, 0xFF])   # SM3.0 vertex shader
SEP        = bytes([0xFF, 0xFF, 0xFF, 0xFF])   # separator between sub-blobs
END_TOKEN  = bytes([0xFF, 0xFF, 0x00, 0x00])   # DX9 shader end instruction

INPUT  = sys.argv[1] if len(sys.argv) > 1 else "shaders_sm30"
OUTDIR = sys.argv[2] if len(sys.argv) > 2 else "shadersOut"


def parse_pdhs(data):
    if data[:4] != PDHS_MAGIC:
        raise ValueError(f"Not a PDHS file (got {data[:4]!r})")
    version    = struct.unpack_from("<I", data, 4)[0]
    num_entries = struct.unpack_from("<I", data, 8)[0]
    print(f"PDHS v{version}, {num_entries} entries")

    pos = 12
    entries = []
    while pos < len(data) - 6:
        name_len = struct.unpack_from("<H", data, pos)[0]
        if name_len == 0 or name_len > 128:
            break
        pos += 2
        name = data[pos:pos + name_len].decode("ascii", errors="replace")
        pos += name_len
        blob_size = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        entries.append((name, data[pos:pos + blob_size]))
        pos += blob_size

    return entries


def iter_sep_blobs(blob):
    """Yield (kind, sub_blob) for every FFFFFFFF-prefixed sub-blob in blob"""
    p = 0
    while p < len(blob) - 16:
        if blob[p:p + 4] == SEP:
            kind      = struct.unpack_from("<I", blob, p + 4)[0]
            # field at p+8 is unused (always 0)
            blob_size = struct.unpack_from("<I", blob, p + 12)[0]
            start     = p + 16
            end       = start + blob_size
            yield kind, blob[start:end]
            p = end
        else:
            p += 1


def reconstruct_shader(blob):
    """
    Fix the split-storage format used in shaders_sm30.

    Layout inside each sub-blob:
        [version token (4)]
        [comment opcode FEFF + length N (4)]
        [CTAB data (N*4)]        ← header ends here
        [arithmetic/tex ops]
        [FFFF0000]               ← fake end token (split point)
        [def/dcl declarations]   ← tail that must precede the main instructions

    Valid DX9 bytecode order:
        version + CTAB + def/dcl (tail) + arithmetic/tex (main) + FFFF0000

    If there is no tail (tail_size == 0) the blob is already correct.
    """
    if len(blob) < 8:
        return None

    magic = blob[:4]
    if magic not in (PS_MAGIC, VS_MAGIC):
        return None                       # not a PS/VS shader

    # Locate end of CTAB comment header
    comment_len_dwords = struct.unpack_from("<H", blob, 6)[0]  # N
    header_end = 4 + 4 + comment_len_dwords * 4               # after CTAB

    if header_end >= len(blob):
        return blob                       # malformed — return as-is

    # Find the first FFFF0000 that follows the header
    split_off = blob.find(END_TOKEN, header_end)

    if split_off == -1:
        # No end token found at all — return as-is
        return blob

    tail = blob[split_off + 4:]          # def/dcl instructions
    main = blob[header_end:split_off]    # arithmetic/texture instructions
    header = blob[:header_end]           # version + CTAB

    if not tail:
        # No split needed — blob already ends at the real end token
        return blob

    # Reassemble in the correct DX9 instruction order
    reconstructed = header + tail + main + END_TOKEN
    assert len(reconstructed) == len(blob), (
        f"Size mismatch after reconstruct: {len(reconstructed)} != {len(blob)}"
    )
    return reconstructed


def validate_shader(data, name):
    """Basic sanity checks on a reconstructed shader blob."""
    if len(data) < 8:
        print(f"  WARN {name}: too short ({len(data)} bytes)")
        return False
    if data[:4] not in (PS_MAGIC, VS_MAGIC):
        print(f"  WARN {name}: bad magic {data[:4].hex()}")
        return False
    if data[-4:] != END_TOKEN:
        print(f"  WARN {name}: does not end with FFFF0000 (ends {data[-4:].hex()})")
        return False
    return True


def main():
    data = open(INPUT, "rb").read()
    os.makedirs(OUTDIR, exist_ok=True)

    entries = parse_pdhs(data)
    print()

    total_ps = total_vs = total_skip = 0

    for entry_name, blob in entries:
        safe   = entry_name.replace("/", "_")
        ps_idx = vs_idx = 0
        has_shaders = False

        for kind, sub in iter_sep_blobs(blob):
            magic = sub[:4] if sub else b''

            if magic == PS_MAGIC:
                shader = reconstruct_shader(sub)
                fname  = f"ps_{safe}_{ps_idx}.fxc"
                fpath  = os.path.join(OUTDIR, fname)
                open(fpath, "wb").write(shader)
                tail_bytes = len(sub) - (sub.find(END_TOKEN, 8) + 4 if sub.find(END_TOKEN, 8) != -1 else len(sub))
                valid = validate_shader(shader, fname)
                print(f"  PS {entry_name}[{ps_idx}] kind={kind:2d} "
                      f"blob={len(sub)} tail={max(tail_bytes,0)} -> {fname} {'OK' if valid else 'WARN'}")
                ps_idx += 1
                has_shaders = True
                total_ps += 1

            elif magic == VS_MAGIC:
                shader = reconstruct_shader(sub)
                fname  = f"vs_{safe}_{vs_idx}.fxc"
                fpath  = os.path.join(OUTDIR, fname)
                open(fpath, "wb").write(shader)
                tail_bytes = len(sub) - (sub.find(END_TOKEN, 8) + 4 if sub.find(END_TOKEN, 8) != -1 else len(sub))
                valid = validate_shader(shader, fname)
                print(f"  VS {entry_name}[{vs_idx}] kind={kind:2d} "
                      f"blob={len(sub)} tail={max(tail_bytes,0)} -> {fname} {'OK' if valid else 'WARN'}")
                vs_idx += 1
                has_shaders = True
                total_vs += 1

            else:
                # kind=2 FX effect blobs (CullMode, blend states, etc.) — skip
                total_skip += 1

        if not has_shaders:
            print(f"  (skip) {entry_name} — parameter table only, no shader bytecode")

    print()
    print(f"Done: {total_ps} PS + {total_vs} VS = {total_ps+total_vs} shaders written to '{OUTDIR}/'")
    print(f"      {total_skip} non-shader sub-blobs skipped (FX effect / render-state entries)")


if __name__ == "__main__":
    main()
