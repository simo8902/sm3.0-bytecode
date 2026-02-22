// decal_ps.hlsl
// Decal pixel shader — all 4 permutations decompiled from ps_decal_{0-3}.fxc
//
// Permutation matrix:
//   ps_decal_0 — no invModel, no specular  (emissive decal, simple)
//   ps_decal_1 — with invModel, no specular (projected animated-object decal)
//   ps_decal_2 — no invModel, with specular (specular decal, static)
//   ps_decal_3 — with invModel, with specular (specular decal, animated object)
//
// All variants reconstruct world position from the screen-space normal/light buffer,
// project the decal onto that surface, and apply fog.
//
// Constants NOT listed in CTAB (engine-set at runtime):
//   depthScale       — scales the packed depth decoded from the normal buffer ZW
//   heightFogDensity — blend rate for the height-based fog layer
//   fogDensity       — blend rate for the linear distance fog
//   (uvTileScale in variants 3 — separate tiling for color vs alpha textures)

// ============================================================
//  Shared helper functions
// ============================================================

// Decode a 16-bit depth packed into two 8-bit channels (stored as [0,1] floats)
float DecodePackedDepth(float2 zw)
{
    return zw.x * 65536.0 + zw.y * 256.0;
}

// Remap projected NDC XY [-1,1] to UV [0,1] with Y-axis flipped (DX screen convention)
float2 NDCtoUV(float2 ndc)
{
    return ndc * float2(0.5, -0.5) + 0.5;
}

// Clamp a fog factor to [minFog, 1] and lerp toward fog colour
float3 ApplyLinearFog(float3 colour, float3 fogColour, float minFogFactor, float fogFactor)
{
    float f = clamp(fogFactor, minFogFactor, 1.0);
    return lerp(fogColour, colour, f);
}


// ============================================================
//  ps_decal_0
//  No invModel, no specular.
//  Projection rows come from interpolated vertex data (TEXCOORD3/4).
// ============================================================
sampler2D ps0_lightSampler               : register(s0);
sampler2D ps0_normalMapSampler           : register(s1);
sampler2D ps0_effectDecalColorMapSampler : register(s2);
sampler2D ps0_decalAlphaMaskSampler      : register(s3);

float4x4 ps0_invView              : register(c0);   // inverse view matrix
float4   ps0_depthScale           : register(c4);   // .x = depth decode multiplier (engine)
float4   ps0_heightFogDensity     : register(c5);   // .x = height fog blend rate   (engine)
float4   ps0_fogDensity           : register(c6);   // .x = linear fog blend rate   (engine)
float    ps0_MatEmissiveIntensity : register(c7);
float4   ps0_pixelSize            : register(c8);   // xy = 1/screenW, 1/screenH
float4   ps0_fogDistances         : register(c9);   // .y = far clip for fog
float4   ps0_fogColor             : register(c10);  // rgb = colour, .w = min fog factor
float4   ps0_heightFogColor       : register(c11);  // rgb = colour, .w = height threshold
float    ps0_mayaAnimableAlpha    : register(c12);

struct PS0_Input
{
    float3 normalWS  : TEXCOORD0;  // world-space surface normal (interpolated)
    float  fogDepth  : TEXCOORD1;  // depth value used for linear fog (.z)
    float4 projRow0  : TEXCOORD3;  // decal projection plane row 0
    float4 projRow1  : TEXCOORD4;  // decal projection plane row 1
    float2 vPos      : VPOS;       // screen pixel position (from SV_Position)
};

float4 PS_Decal0(PS0_Input i) : COLOR
{
    // --- Screen-space UV from pixel position ---
    float2 screenUV = (0.5 + i.vPos) * ps0_pixelSize.xy;

    // --- Sample screen-space buffers ---
    float4 normalSample = tex2D(ps0_normalMapSampler, screenUV);
    float4 lightSample  = tex2D(ps0_lightSampler,     screenUV);

    // --- Reconstruct world position from packed depth in normal buffer ZW ---
    // Normal buffer ZW stores a 16-bit depth split across two 8-bit channels.
    float rawDepth = DecodePackedDepth(normalSample.zw);
    float depth    = rawDepth * ps0_depthScale.x;

    // --- Scale world normal by depth, build homogeneous position ---
    float3 N          = normalize(i.normalWS);
    float4 worldPoint = float4(depth * N, 1.0);

    // --- Transform world point into light/decal space via invView ---
    float4 lightSpacePos = mul(ps0_invView, worldPoint);

    // --- Compute 2D decal UV by dot-producting with projection plane rows ---
    float2 projUV;
    projUV.x = dot(i.projRow0, lightSpacePos);
    projUV.y = dot(i.projRow1, lightSpacePos);

    // --- Height fog blend (how far below the height fog plane we are) ---
    float heightFogBlend = saturate((ps0_heightFogColor.w - lightSpacePos.y)
                                    * ps0_heightFogDensity.x);

    // --- Perspective divide, then remap NDC → UV ---
    projUV /= lightSpacePos.w;
    float2 decalUV = NDCtoUV(projUV);

    // --- Sample decal textures at projected UV ---
    float4 decalColor   = tex2D(ps0_effectDecalColorMapSampler, decalUV);
    float4 emissiveMask = tex2D(ps0_decalAlphaMaskSampler,      decalUV);

    float alpha = decalColor.a * ps0_mayaAnimableAlpha;

    // --- Lit colour: light buffer × decal diffuse, ×2 for HDR light range ---
    float3 colour = lightSample.rgb * decalColor.rgb * 2.0;

    // --- Add emissive contribution ---
    colour += emissiveMask.rgb * ps0_MatEmissiveIntensity;

    // --- Linear fog ---
    float fogFactor = (ps0_fogDistances.y - i.fogDepth) * ps0_fogDensity.x;
    colour = ApplyLinearFog(colour, ps0_fogColor.rgb, ps0_fogColor.w, fogFactor);

    // --- Height fog blended on top ---
    colour = lerp(ps0_heightFogColor.rgb, colour, heightFogBlend);

    // Output is halved to match the render-target's [0, 2] HDR range
    return float4(colour * 0.5, alpha);
}


// ============================================================
//  ps_decal_1
//  With invModel (animated object), no specular.
//  Decal UV is derived from invModel, not interpolated rows.
// ============================================================
sampler2D ps1_lightSampler               : register(s0);
sampler2D ps1_normalMapSampler           : register(s1);
sampler2D ps1_effectDecalColorMapSampler : register(s2);
sampler2D ps1_decalAlphaMaskSampler      : register(s3);

float4x4 ps1_invView              : register(c0);
float4x4 ps1_invModel             : register(c4);   // inverse model matrix (4 rows)
float4   ps1_depthScale           : register(c8);   // .x (engine)
float4   ps1_heightFogDensity     : register(c9);   // .x (engine)
float4   ps1_fogDensity           : register(c10);  // .x (engine)
float    ps1_MatEmissiveIntensity : register(c11);
float4   ps1_pixelSize            : register(c12);
float4   ps1_fogDistances         : register(c13);  // .y = far fog dist
float4   ps1_fogColor             : register(c14);  // .w = min fog factor
float4   ps1_heightFogColor       : register(c15);  // .w = height threshold
float    ps1_mayaAnimableAlpha    : register(c16);

struct PS1_Input
{
    float3 normalWS : TEXCOORD0;
    float  fogDepth : TEXCOORD1;   // .z
    float2 vPos     : VPOS;
};

float4 PS_Decal1(PS1_Input i) : COLOR
{
    // --- Screen-space UV ---
    float2 screenUV = (0.5 + i.vPos) * ps1_pixelSize.xy;

    // --- Screen-space buffer samples ---
    float4 normalSample = tex2D(ps1_normalMapSampler, screenUV);
    float4 lightSample  = tex2D(ps1_lightSampler,     screenUV);

    // --- Decode depth and reconstruct world point ---
    float depth       = DecodePackedDepth(normalSample.zw) * ps1_depthScale.x;
    float4 worldPoint = float4(depth * normalize(i.normalWS), 1.0);

    // --- Transform to light space ---
    float4 lightSpacePos = mul(ps1_invView, worldPoint);

    // --- Transform to object space via invModel (top-down XZ projection) ---
    // Row 1 (Y) is intentionally skipped — decal projects along the Y axis.
    // Assembly: dp4 row0, dp4 row2, dp4 row3 only (no row1).
    float objX = dot(lightSpacePos, ps1_invModel[0]);
    float objZ = dot(lightSpacePos, ps1_invModel[2]);
    float objW = dot(lightSpacePos, ps1_invModel[3]);

    // --- Height fog uses light-space Y before it's discarded ---
    float heightFogBlend = saturate((ps1_heightFogColor.w - lightSpacePos.y)
                                    * ps1_heightFogDensity.x);

    // --- Perspective divide: ×2 maps model space [-0.5, 0.5] → NDC [-1, 1] ---
    float invW    = rcp(objW);
    float2 projUV = float2(objX * 2.0, objZ * 2.0) * invW;
    float2 decalUV = NDCtoUV(projUV);

    // --- Sample decal textures ---
    float4 decalColor   = tex2D(ps1_effectDecalColorMapSampler, decalUV);
    float4 emissiveMask = tex2D(ps1_decalAlphaMaskSampler,      decalUV);

    float alpha = decalColor.a * ps1_mayaAnimableAlpha;

    // --- Colour: light × diffuse ×2 + emissive ---
    float3 colour = lightSample.rgb * decalColor.rgb * 2.0;
    colour += emissiveMask.rgb * ps1_MatEmissiveIntensity;

    // --- Fog ---
    float fogFactor = (ps1_fogDistances.y - i.fogDepth) * ps1_fogDensity.x;
    colour = ApplyLinearFog(colour, ps1_fogColor.rgb, ps1_fogColor.w, fogFactor);
    colour = lerp(ps1_heightFogColor.rgb, colour, heightFogBlend);

    return float4(colour * 0.5, alpha);
}


// ============================================================
//  ps_decal_2
//  No invModel, WITH specular.
//  Two UV sets: projected UV for colour+spec, separate UV for alpha mask.
// ============================================================
sampler2D ps2_specMapSampler          : register(s0);
sampler2D ps2_lightSampler            : register(s1);
sampler2D ps2_normalMapSampler        : register(s2);
sampler2D ps2_decalColorMapSampler    : register(s3);
sampler2D ps2_decalAlphaMaskSampler   : register(s4);

float4x4 ps2_invView               : register(c0);
float4   ps2_depthScale            : register(c4);   // .x (engine)
float4   ps2_heightFogDensity      : register(c5);   // .x (engine)
float4   ps2_fogDensity            : register(c6);   // .x (engine)
float    ps2_MatSpecularIntensity  : register(c7);
float    ps2_MatSpecularPower      : register(c8);
float4   ps2_pixelSize             : register(c9);
float4   ps2_fogDistances          : register(c10);  // .y = far
float4   ps2_fogColor              : register(c11);  // .w = min factor
float4   ps2_heightFogColor        : register(c12);  // .w = threshold
float    ps2_encodefactor          : register(c13);  // specular encode scale
float    ps2_diffuseTextureScaling : register(c14);  // tiling scale for colour/spec

struct PS2_Input
{
    float3 normalWS   : TEXCOORD0;
    float  fogDepth   : TEXCOORD1;   // .z
    float2 maskScale  : TEXCOORD3;   // .xy  per-vertex UV scale for the alpha mask
    float4 projRow0   : TEXCOORD4;   // decal projection plane row 0
    float4 projRow1   : TEXCOORD5;   // decal projection plane row 1
    float2 vPos       : VPOS;
};

float4 PS_Decal2(PS2_Input i) : COLOR
{
    // --- Screen-space UV ---
    float2 screenUV = (0.5 + i.vPos) * ps2_pixelSize.xy;

    // --- Screen-space buffers ---
    float4 normalSample = tex2D(ps2_normalMapSampler, screenUV);
    float4 lightSample  = tex2D(ps2_lightSampler,     screenUV);

    // --- World point reconstruction ---
    float depth       = DecodePackedDepth(normalSample.zw) * ps2_depthScale.x;
    float4 worldPoint = float4(depth * normalize(i.normalWS), 1.0);

    // --- Light space transform ---
    float4 lightSpacePos = mul(ps2_invView, worldPoint);

    // --- Projective decal UV from interpolated vertex rows ---
    float2 projUV;
    projUV.x = dot(i.projRow0, lightSpacePos);
    projUV.y = dot(i.projRow1, lightSpacePos);

    // --- Height fog ---
    float heightFogBlend = saturate((ps2_heightFogColor.w - lightSpacePos.y)
                                    * ps2_heightFogDensity.x);

    // --- Colour/spec UV: (projUV * diffuseTextureScaling) / perspW, remapped to [0,1] ---
    // Assembly saves (perspW * maskScale.xy) in r2.zw before the perspective divide,
    // so we can recover the mask UV later using a second rcp without re-doing the dp4.
    float  perspW       = lightSpacePos.w;
    float2 scaledProjUV = projUV * ps2_diffuseTextureScaling;
    float2 colorUV      = NDCtoUV(scaledProjUV / perspW);

    // --- Colour + specular samples ---
    float4 decalColor = tex2D(ps2_decalColorMapSampler, colorUV);
    float4 specSample = tex2D(ps2_specMapSampler,        colorUV);

    // mad r3, r3.xyzx, (1,1,1,0), (0,0,0,1): keeps rgb, forces alpha = 1.0
    float4 decalExpanded = float4(decalColor.rgb, 1.0);

    // --- Light × decal (light.w carries specular highlight intensity) ---
    float4 litDecal = lightSample * decalExpanded;

    // --- Specular ---
    float specHighlight = pow(abs(litDecal.w), ps2_MatSpecularPower);
    float3 specColour   = specSample.rgb * ps2_MatSpecularIntensity;

    // --- Colour assembly: diffuse ×2 + specular ---
    float3 colour = litDecal.rgb * 2.0;
    colour += specColour * (specHighlight * ps2_encodefactor);

    // --- Fog (linear + height) ---
    float fogFactor = (ps2_fogDistances.y - i.fogDepth) * ps2_fogDensity.x;
    colour = ApplyLinearFog(colour, ps2_fogColor.rgb, ps2_fogColor.w, fogFactor);
    colour = lerp(ps2_heightFogColor.rgb, colour, heightFogBlend);

    // --- Alpha mask UV: projUV / (perspW * maskScale) — independent of diffuse tiling ---
    // maskScale (TEXCOORD3.xy) lets the alpha mask cover the full decal area regardless
    // of how many times the colour texture tiles.
    float2 maskUV = NDCtoUV(projUV / (perspW * i.maskScale));
    float4 alphaMask = tex2D(ps2_decalAlphaMaskSampler, maskUV);

    // Alpha comes from the mask's red channel only (single-channel mask texture)
    return float4(colour * 0.5, alphaMask.x);
}


// ============================================================
//  ps_decal_3
//  WITH invModel + WITH specular. Most feature-complete variant.
//  Uses top-down XZ projection via invModel (decal on animated mesh).
// ============================================================
sampler2D ps3_specMapSampler        : register(s0);
sampler2D ps3_lightSampler          : register(s1);
sampler2D ps3_normalMapSampler      : register(s2);
sampler2D ps3_decalColorMapSampler  : register(s3);
sampler2D ps3_decalAlphaMaskSampler : register(s4);

float4x4 ps3_invView               : register(c0);
float4x4 ps3_invModel              : register(c4);
float4   ps3_depthScale            : register(c8);   // .x (engine)
float4   ps3_uvTileScale           : register(c9);   // .xy: UV tile for colour/spec vs mask
float4   ps3_heightFogDensity      : register(c10);  // .x (engine)
float4   ps3_fogDensity            : register(c11);  // .x (engine)
float    ps3_MatSpecularIntensity  : register(c12);
float    ps3_MatSpecularPower      : register(c13);
float4   ps3_pixelSize             : register(c14);
float4   ps3_fogDistances          : register(c15);  // .y = far
float4   ps3_fogColor              : register(c16);  // .w = min factor
float4   ps3_heightFogColor        : register(c17);  // .w = threshold
float    ps3_encodefactor          : register(c18);
float    ps3_mayaAnimableAlpha     : register(c19);
float    ps3_diffuseTextureScaling : register(c20);

struct PS3_Input
{
    float3 normalWS : TEXCOORD0;
    float  fogDepth : TEXCOORD1;   // .z
    float2 vPos     : VPOS;
};

float4 PS_Decal3(PS3_Input i) : COLOR
{
    // --- Screen-space UV ---
    float2 screenUV = (0.5 + i.vPos) * ps3_pixelSize.xy;

    // --- Screen-space buffers ---
    float4 normalSample = tex2D(ps3_normalMapSampler, screenUV);
    float4 lightSample  = tex2D(ps3_lightSampler,     screenUV);

    // --- World point reconstruction ---
    float depth       = DecodePackedDepth(normalSample.zw) * ps3_depthScale.x;
    float4 worldPoint = float4(depth * normalize(i.normalWS), 1.0);

    // --- Light space position ---
    float4 lightSpacePos = mul(ps3_invView, worldPoint);

    // --- Project into object space via invModel (top-down XZ, skip Y row) ---
    float objX = dot(lightSpacePos, ps3_invModel[0]);
    float objZ = dot(lightSpacePos, ps3_invModel[2]);
    float objW = dot(lightSpacePos, ps3_invModel[3]);

    // --- Height fog uses light-space Y ---
    float heightFogBlend = saturate((ps3_heightFogColor.w - lightSpacePos.y)
                                    * ps3_heightFogDensity.x);

    // --- Perspective divide: object XZ → NDC, ×2 because model space is [-0.5, 0.5] ---
    float invW    = rcp(objW);
    float2 projUV = float2(objX, objZ) * 2.0 * invW;
    float2 baseUV = NDCtoUV(projUV);

    // --- Alpha mask sampled at base projected UV ---
    float4 alphaMask = tex2D(ps3_decalAlphaMaskSampler, baseUV);
    float  alpha     = alphaMask.x * ps3_mayaAnimableAlpha;

    // --- Colour/spec UV: base UV × diffuseTextureScaling × per-axis uvTileScale ---
    // Assembly: mul r1.zw, r1.xy, diffuseTextureScaling   (r1.zw = tiled UV)
    //           mul r1.xy, r1.zw, c9.xy                   (r1.xy = tiled UV × uvTileScale)
    float2 colorUV = baseUV * ps3_diffuseTextureScaling * ps3_uvTileScale.xy;

    // --- Sample colour, spec textures ---
    float4 decalColor = tex2D(ps3_decalColorMapSampler, colorUV);
    float4 specSample = tex2D(ps3_specMapSampler,        colorUV);

    // --- Expand decal colour (sets alpha=1 before light multiply) ---
    float4 decalExpanded = float4(decalColor.rgb, 1.0);

    // --- Light × decal ---
    float4 litDecal = lightSample * decalExpanded;

    // --- Specular ---
    float specHighlight = pow(abs(litDecal.w), ps3_MatSpecularPower);
    float3 specColour   = specSample.rgb * ps3_MatSpecularIntensity;

    // --- Colour assembly ---
    float3 colour = litDecal.rgb * 2.0;
    colour += specColour * (specHighlight * ps3_encodefactor);

    // --- Fog ---
    float fogFactor = (ps3_fogDistances.y - i.fogDepth) * ps3_fogDensity.x;
    colour = ApplyLinearFog(colour, ps3_fogColor.rgb, ps3_fogColor.w, fogFactor);
    colour = lerp(ps3_heightFogColor.rgb, colour, heightFogBlend);

    return float4(colour * 0.5, alpha);
}
