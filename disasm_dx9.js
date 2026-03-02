// DX9 Shader Model 3.0 bytecode disassembler
const fs = require('fs');
const path = require('path');

const OPCODES = {
  0x00: 'nop', 0x01: 'mov', 0x02: 'add', 0x03: 'sub', 0x04: 'mad',
  0x05: 'mul', 0x06: 'rcp', 0x07: 'rsq', 0x08: 'dp3', 0x09: 'dp4',
  0x0A: 'min', 0x0B: 'max', 0x0C: 'slt', 0x0D: 'sge', 0x0E: 'exp',
  0x0F: 'log', 0x10: 'lit', 0x11: 'dst', 0x12: 'lrp', 0x13: 'frc',
  0x14: 'm4x4', 0x15: 'm4x3', 0x16: 'm3x4', 0x17: 'm3x3', 0x18: 'm3x2',
  0x19: 'call', 0x1A: 'callnz', 0x1B: 'loop', 0x1C: 'ret',
  0x1D: 'endloop', 0x1E: 'label', 0x1F: 'dcl', 0x20: 'pow',
  0x21: 'crs', 0x22: 'sgn', 0x23: 'abs', 0x24: 'nrm', 0x25: 'sincos',
  0x26: 'rep', 0x27: 'endrep', 0x28: 'if', 0x29: 'ifc', 0x2A: 'else',
  0x2B: 'endif', 0x2C: 'break', 0x2D: 'breakc', 0x2E: 'mova',
  0x2F: 'defb', 0x30: 'defi',
  0x41: 'texkill', 0x42: 'texld', 0x43: 'texbem', 0x44: 'texbeml',
  0x45: 'texreg2ar', 0x46: 'texreg2gb', 0x47: 'texm3x2pad',
  0x48: 'texm3x2tex', 0x49: 'texm3x3pad', 0x4A: 'texm3x3tex',
  0x4C: 'texm3x3spec', 0x4D: 'texm3x3vspec',
  0x51: 'def', 0x5C: 'texldl', 0x5D: 'breakp',
};

const COMP_OPS = { 1: '_gt', 2: '_eq', 3: '_ge', 4: '_lt', 5: '_ne', 6: '_le' };

const SWIZZLE_NAMES = ['x', 'y', 'z', 'w'];

const REG_TYPE_NAMES = {
  0: 'r', 1: 'v', 2: 'c', 3: 'a', 4: 'rast', 5: 'oD', 6: 'o',
  7: 'i', 8: 'oC', 9: 'oDepth', 10: 's', 11: 'c', 12: 'c', 13: 'c',
  14: 'b', 15: 'aL', 16: 'r16f', 17: 'misc', 18: 'l', 19: 'p'
};

const DCL_USAGE = {
  0: 'position', 1: 'blendweight', 2: 'blendindices', 3: 'normal',
  4: 'psize', 5: 'texcoord', 6: 'tangent', 7: 'binormal',
  8: 'tessfactor', 9: 'positiont', 10: 'color', 11: 'fog', 12: 'depth',
  13: 'sample'
};

const SRC_MOD = {
  0: '', 1: '-', 2: 'bias_', 3: '-bias_', 4: 'sign_', 5: '-sign_',
  6: '1-', 7: 'x2_', 8: '-x2_', 9: 'dz_', 10: 'dw_',
  11: 'abs_', 12: '-abs_', 13: '!'
};

function getRegType(token) {
  return ((token >> 28) & 0x7) | (((token >> 11) & 0x3) << 3);
}

function getRegNum(token) {
  return token & 0x7FF;
}

function formatSwizzle(token) {
  const sx = (token >> 16) & 0x3;
  const sy = (token >> 18) & 0x3;
  const sz = (token >> 20) & 0x3;
  const sw = (token >> 22) & 0x3;
  if (sx === 0 && sy === 1 && sz === 2 && sw === 3) return '';
  if (sx === sy && sy === sz && sz === sw) return '.' + SWIZZLE_NAMES[sx];
  let s = '.' + SWIZZLE_NAMES[sx] + SWIZZLE_NAMES[sy] + SWIZZLE_NAMES[sz] + SWIZZLE_NAMES[sw];
  // Trim trailing repeated
  while (s.length > 2 && s[s.length-1] === s[s.length-2]) s = s.slice(0, -1);
  return s;
}

function formatWriteMask(token) {
  const mask = (token >> 16) & 0xF;
  if (mask === 0xF) return '';
  let s = '.';
  if (mask & 1) s += 'x';
  if (mask & 2) s += 'y';
  if (mask & 4) s += 'z';
  if (mask & 8) s += 'w';
  return s;
}

function formatSrcReg(token, isPS) {
  const regType = getRegType(token);
  const regNum = getRegNum(token);
  const srcMod = (token >> 24) & 0xF;
  const swizzle = formatSwizzle(token);
  
  let prefix = REG_TYPE_NAMES[regType] || `unk${regType}_`;
  if (regType === 3 && isPS) prefix = 't';
  if (regType === 17) {
    prefix = regNum === 0 ? 'vFace' : 'vPos';
    return (SRC_MOD[srcMod] || '') + prefix + swizzle;
  }
  if (regType === 15) return 'aL' + swizzle;
  
  return (SRC_MOD[srcMod] || '') + prefix + regNum + swizzle;
}

function formatDstReg(token, isPS) {
  const regType = getRegType(token);
  const regNum = getRegNum(token);
  const mask = formatWriteMask(token);
  const saturate = (token >> 20) & 0x1;
  
  let prefix = REG_TYPE_NAMES[regType] || `unk${regType}_`;
  if (regType === 3 && isPS) prefix = 't';
  if (regType === 17) {
    prefix = regNum === 0 ? 'vFace' : 'vPos';
    return { text: prefix + mask, saturate };
  }
  if (regType === 9) return { text: 'oDepth' + mask, saturate };
  
  return { text: prefix + regNum + mask, saturate: saturate };
}

function parseCTAB(data, offset, sizeBytes) {
  const result = { constants: [], creator: '' };
  if (sizeBytes < 28) return result;
  
  const magic = data.readUInt32LE(offset);
  if (magic !== 0x42415443) return result; // 'CTAB'
  
  const size = data.readUInt32LE(offset + 4);
  const creator_off = data.readUInt32LE(offset + 8);
  const version = data.readUInt32LE(offset + 12);
  const numConstants = data.readUInt32LE(offset + 16);
  const constInfo_off = data.readUInt32LE(offset + 20);
  
  // Read creator string
  if (creator_off < sizeBytes) {
    let end = creator_off;
    while (end < sizeBytes && data[offset + end] !== 0) end++;
    result.creator = data.slice(offset + creator_off, offset + end).toString('ascii');
  }
  
  // Read constant info
  for (let i = 0; i < numConstants && (constInfo_off + i * 20 + 20) <= sizeBytes; i++) {
    const ci_off = offset + constInfo_off + i * 20;
    const nameOff = data.readUInt32LE(ci_off);
    const regSet = data.readUInt16LE(ci_off + 4);
    const regIndex = data.readUInt16LE(ci_off + 6);
    const regCount = data.readUInt16LE(ci_off + 8);
    const typeInfoOff = data.readUInt32LE(ci_off + 12);
    const defaultValue = data.readUInt32LE(ci_off + 16);
    
    let name = '';
    if (nameOff < sizeBytes) {
      let end = nameOff;
      while (end < sizeBytes && data[offset + end] !== 0) end++;
      name = data.slice(offset + nameOff, offset + end).toString('ascii');
    }
    
    // Parse type info
    let typeClass = -1, type = -1, rows = 0, cols = 0, elements = 0;
    if (typeInfoOff + 16 <= sizeBytes) {
      const ti_off = offset + typeInfoOff;
      typeClass = data.readUInt16LE(ti_off);
      type = data.readUInt16LE(ti_off + 2);
      rows = data.readUInt16LE(ti_off + 4);
      cols = data.readUInt16LE(ti_off + 6);
      elements = data.readUInt16LE(ti_off + 8);
    }
    
    const regSetNames = ['bool', 'int4', 'float4', 'sampler'];
    const classNames = ['scalar', 'vector', 'row_major', 'col_major', 'object', 'struct'];
    const typeNames = ['void','bool','int','float','string','texture','texture1d','texture2d','texture3d','textureCube','sampler','sampler1d','sampler2d','sampler3d','samplerCube','pixelShader','vertexShader','pixelFragment','vertexFragment','unsupported'];
    
    result.constants.push({
      name,
      regSet: regSetNames[regSet] || `set${regSet}`,
      regIndex,
      regCount,
      typeClass: classNames[typeClass] || `class${typeClass}`,
      type: typeNames[type] || `type${type}`,
      rows, cols, elements
    });
  }
  
  return result;
}

function disassemble(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length < 8) return { error: 'File too small' };
  
  const versionToken = data.readUInt32LE(0);
  const major = (versionToken >> 8) & 0xFF;
  const minor = versionToken & 0xFF;
  const shaderType = (versionToken >> 16) & 0xFFFF;
  const isPS = shaderType === 0xFFFF;
  const isVS = shaderType === 0xFFFE;
  
  if (!isPS && !isVS) return { error: `Unknown shader type: 0x${shaderType.toString(16)}` };
  
  const result = {
    type: isPS ? 'ps' : 'vs',
    version: `${major}.${minor}`,
    ctab: null,
    preshader: null,
    instructions: [],
    defs: [],
    dcls: []
  };
  
  let pos = 4; // skip version token
  
  while (pos + 4 <= data.length) {
    const token = data.readUInt32LE(pos);
    
    // End token
    if (token === 0x0000FFFF) {
      result.instructions.push({ op: 'end', text: '// end' });
      break;
    }
    
    const opcode = token & 0xFFFF;
    
    // Comment token
    if (opcode === 0xFFFE) {
      const commentLen = (token >> 16) & 0xFFFF; // in DWORDs
      const commentStart = pos + 4;
      const commentBytes = commentLen * 4;
      
      // Check for CTAB
      if (commentLen >= 1) {
        const commentMagic = data.readUInt32LE(commentStart);
        if (commentMagic === 0x42415443) { // 'CTAB'
          result.ctab = parseCTAB(data, commentStart, commentBytes);
        } else if (commentMagic === 0x53455250) { // 'PRES' - preshader
          result.preshader = { offset: commentStart, size: commentBytes };
          // Try to parse preshader ops
          result.preshaderOps = parsePreshader(data, commentStart, commentBytes);
        }
      }
      
      pos += 4 + commentBytes;
      continue;
    }
    
    const instrLen = (token >> 24) & 0xF; // additional DWORDs for most opcodes
    const opName = OPCODES[opcode] || `unk_0x${opcode.toString(16)}`;
    
    // def instruction: opcode + dst + 4 floats
    if (opcode === 0x51) {
      const dst = data.readUInt32LE(pos + 4);
      const f0 = data.readFloatLE(pos + 8);
      const f1 = data.readFloatLE(pos + 12);
      const f2 = data.readFloatLE(pos + 16);
      const f3 = data.readFloatLE(pos + 20);
      const regType = getRegType(dst);
      const regNum = getRegNum(dst);
      const prefix = REG_TYPE_NAMES[regType] || 'c';
      const defText = `def ${prefix}${regNum}, ${f0}, ${f1}, ${f2}, ${f3}`;
      result.defs.push({ reg: `${prefix}${regNum}`, values: [f0, f1, f2, f3] });
      result.instructions.push({ op: 'def', text: defText });
      pos += 24;
      continue;
    }
    
    // defi instruction
    if (opcode === 0x30) {
      const dst = data.readUInt32LE(pos + 4);
      const i0 = data.readInt32LE(pos + 8);
      const i1 = data.readInt32LE(pos + 12);
      const i2 = data.readInt32LE(pos + 16);
      const i3 = data.readInt32LE(pos + 20);
      const regNum = getRegNum(dst);
      result.instructions.push({ op: 'defi', text: `defi i${regNum}, ${i0}, ${i1}, ${i2}, ${i3}` });
      pos += 24;
      continue;
    }
    
    // dcl instruction
    if (opcode === 0x1F) {
      const dclToken = data.readUInt32LE(pos + 4);
      const dstToken = data.readUInt32LE(pos + 8);
      const dstReg = formatDstReg(dstToken, isPS);
      const regType = getRegType(dstToken);
      
      if (regType === 10) { // sampler
        const samplerType = (dclToken >> 27) & 0xF;
        const samplerTypes = { 0: '2d', 2: '2d', 3: 'cube', 4: 'volume' };
        result.dcls.push({ reg: dstReg.text.split('.')[0], usage: `sampler_${samplerTypes[samplerType] || samplerType}` });
        result.instructions.push({ op: 'dcl', text: `dcl_${samplerTypes[samplerType] || samplerType} ${dstReg.text}` });
      } else {
        const usage = dclToken & 0x1F;
        const usageIndex = (dclToken >> 16) & 0xF;
        const usageName = DCL_USAGE[usage] || `usage${usage}`;
        const indexStr = usageIndex > 0 ? usageIndex : '';
        result.dcls.push({ reg: dstReg.text.split('.')[0], usage: `${usageName}${indexStr}`, mask: formatWriteMask(dstToken) });
        result.instructions.push({ op: 'dcl', text: `dcl_${usageName}${indexStr} ${dstReg.text}` });
      }
      pos += 12;
      continue;
    }
    
    // ifc (comparison if)
    if (opcode === 0x29) {
      const comp = (token >> 16) & 0x7;
      const src0 = formatSrcReg(data.readUInt32LE(pos + 4), isPS);
      const src1 = formatSrcReg(data.readUInt32LE(pos + 8), isPS);
      result.instructions.push({ op: 'ifc', text: `if${COMP_OPS[comp] || '_?'} ${src0}, ${src1}` });
      pos += 12;
      continue;
    }
    
    // breakc
    if (opcode === 0x2D) {
      const comp = (token >> 16) & 0x7;
      const src0 = formatSrcReg(data.readUInt32LE(pos + 4), isPS);
      const src1 = formatSrcReg(data.readUInt32LE(pos + 8), isPS);
      result.instructions.push({ op: 'breakc', text: `break${COMP_OPS[comp] || '_?'} ${src0}, ${src1}` });
      pos += 12;
      continue;
    }
    
    // Generic instruction handling
    const totalTokens = 1 + instrLen;
    const tokens = [];
    for (let i = 0; i < totalTokens && (pos + i*4) + 4 <= data.length; i++) {
      tokens.push(data.readUInt32LE(pos + i * 4));
    }
    
    let text = '';
    
    if (['else', 'endif', 'endloop', 'endrep', 'ret'].includes(opName)) {
      text = opName;
    } else if (['loop', 'rep'].includes(opName)) {
      if (instrLen >= 1) {
        const src = formatSrcReg(tokens[1], isPS);
        text = `${opName} ${src}`;
      } else {
        text = opName;
      }
    } else if (opName === 'if') {
      const src = formatSrcReg(tokens[1], isPS);
      text = `if ${src}`;
    } else if (opName === 'label') {
      const src = formatSrcReg(tokens[1], isPS);
      text = `label ${src}`;
    } else if (opName === 'call' || opName === 'callnz') {
      text = opName;
      for (let i = 1; i < tokens.length; i++) {
        text += (i === 1 ? ' ' : ', ') + formatSrcReg(tokens[i], isPS);
      }
    } else if (opName === 'texkill') {
      const dst = formatDstReg(tokens[1], isPS);
      text = `texkill ${dst.text}`;
    } else if (['texld', 'texldl'].includes(opName)) {
      const dst = formatDstReg(tokens[1], isPS);
      const src0 = formatSrcReg(tokens[2], isPS);
      const src1 = formatSrcReg(tokens[3], isPS);
      const sat = dst.saturate ? '_sat' : '';
      text = `${opName}${sat} ${dst.text}, ${src0}, ${src1}`;
    } else if (instrLen >= 1) {
      // Standard: dst, src0, [src1, [src2]]
      const dst = formatDstReg(tokens[1], isPS);
      const sat = dst.saturate ? '_sat' : '';
      const pred = (token >> 28) & 1;
      const coissue = (token >> 30) & 1;
      
      let sources = [];
      for (let i = 2; i < tokens.length; i++) {
        // Check if token looks like a relative addressing token
        if ((tokens[i] & 0x2000) && i > 1) {
          // This is a relative addressing token, format it
          const relReg = formatSrcReg(tokens[i], isPS);
          if (sources.length > 0) {
            sources[sources.length - 1] += `[${relReg}]`;
          }
        } else {
          sources.push(formatSrcReg(tokens[i], isPS));
        }
      }
      
      text = `${opName}${sat} ${dst.text}, ${sources.join(', ')}`;
    } else {
      text = opName;
    }
    
    result.instructions.push({ op: opName, text, tokens: tokens.map(t => '0x' + t.toString(16).padStart(8, '0')) });
    pos += totalTokens * 4;
  }
  
  return result;
}

function parsePreshader(data, offset, size) {
  // Preshader starts with 'PRES' magic
  // Simple attempt to extract float constants and ops from preshader block
  const ops = [];
  try {
    // Skip PRES magic
    let p = offset + 4;
    // Preshader format varies, just extract what we can
    // Look for recognizable float patterns
    const end = offset + size;
    
    // Version
    if (p + 4 <= end) {
      const ver = data.readUInt32LE(p);
      ops.push(`preshader_version: 0x${ver.toString(16)}`);
      p += 4;
    }
    
    // Try to dump readable constants
    // The preshader contains FXLC (FX Lite Compile) bytecode
    // Just extract the structure for now
    while (p + 4 <= end) {
      const tag = data.slice(p, p + 4).toString('ascii');
      if (tag === 'CLIT' || tag === 'CLTI' || tag === 'FXLC' || tag === 'PRSI') {
        const count = data.readUInt32LE(p + 4);
        ops.push(`${tag}: count=${count}`);
        p += 8;
        if (tag === 'CLIT') {
          // Float constants
          for (let i = 0; i < count && p + 4 <= end; i++) {
            const f = data.readFloatLE(p);
            ops.push(`  clit[${i}] = ${f}`);
            p += 4;
          }
        } else if (tag === 'FXLC') {
          // Bytecode - dump hex for now
          for (let i = 0; i < count && p + 4 <= end; i++) {
            const inst = data.readUInt32LE(p);
            ops.push(`  fxlc[${i}] = 0x${inst.toString(16).padStart(8,'0')}`);
            p += 4;
          }
        } else if (tag === 'PRSI') {
          // Output mapping
          for (let i = 0; i < count && p + 4 <= end; i++) {
            const val = data.readUInt32LE(p);
            ops.push(`  prsi[${i}] = ${val}`);
            p += 4;
          }
        } else {
          p += count * 4;
        }
      } else {
        break;
      }
    }
  } catch (e) {
    ops.push(`parse error: ${e.message}`);
  }
  return ops;
}

function formatDisassembly(result) {
  let out = `// ${result.type}_${result.version}\n`;
  
  if (result.ctab) {
    out += `// ---- CTAB ----\n`;
    if (result.ctab.creator) out += `// Creator: ${result.ctab.creator}\n`;
    for (const c of result.ctab.constants) {
      out += `// ${c.regSet} ${c.name}: ${c.typeClass} ${c.type} [${c.rows}x${c.cols}] reg=${c.regIndex} count=${c.regCount}`;
      if (c.elements > 0) out += ` elements=${c.elements}`;
      out += '\n';
    }
    out += `// ---- END CTAB ----\n`;
  }
  
  if (result.preshaderOps && result.preshaderOps.length > 0) {
    out += `// ---- PRESHADER ----\n`;
    for (const op of result.preshaderOps) {
      out += `// ${op}\n`;
    }
    out += `// ---- END PRESHADER ----\n`;
  }
  
  out += '\n';
  for (const instr of result.instructions) {
    out += `    ${instr.text}\n`;
  }
  
  return out;
}

// Main: disassemble all .fxc files in the specified directory
const dir = process.argv[2] || path.join(__dirname, 'shadersOut', 'standard');
const outDir = process.argv[3] || path.join(__dirname, 'disasm_standard');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(dir).filter(f => f.endsWith('.fxc')).sort((a, b) => {
  // Sort by type (ps/vs) then number
  const aType = a.startsWith('ps') ? 0 : 1;
  const bType = b.startsWith('ps') ? 0 : 1;
  if (aType !== bType) return aType - bType;
  const aNum = parseInt(a.match(/(\d+)/)[1]);
  const bNum = parseInt(b.match(/(\d+)/)[1]);
  return aNum - bNum;
});

let allOutput = '';

for (const file of files) {
  const filePath = path.join(dir, file);
  const result = disassemble(filePath);
  const formatted = formatDisassembly(result);
  
  const outFile = path.join(outDir, file.replace('.fxc', '.asm'));
  fs.writeFileSync(outFile, formatted);
  
  allOutput += `\n// ========== ${file} ==========\n${formatted}\n`;
}

// Write combined output
fs.writeFileSync(path.join(outDir, '_all_standard.asm'), allOutput);
console.log(`Disassembled ${files.length} files to ${outDir}`);
