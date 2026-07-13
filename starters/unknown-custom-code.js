window.CharacterGenerator = (function () {
  "use strict";
  const api = {};
  // ----------------------------------------------------------
  // State
  // ----------------------------------------------------------
  let isGenerating = false;
  let suppressAutoTrigger = false;
  let currentData = null;
  const UNKNOWN_NAME = "unknown";
  const UNKNOWN_AVATAR =
    "https://user.uploads.dev/file/f20fb9e8395310806956dca52510b16b.webp";
  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------
  initialize();
  function initialize() {
    ensureCharacterObjects();
    restoreSavedData();
    registerMessageListener();
  }
  function ensureCharacterObjects() {
    if (!oc.character.customData) {
      oc.character.customData = {};
    }
    if (!oc.character.avatar) {
      oc.character.avatar = {};
    }
  }
  function restoreSavedData() {
    const saved =
      oc.character.customData.generatedCharacterData;
    if (saved) {
      try {
        currentData = clone(saved);
      } catch (error) {
        console.warn(
          "[CharacterGenerator] Could not restore saved character data:",
          error
        );
      }
    }
  }
  // ----------------------------------------------------------
  // Automatic trigger
  // ----------------------------------------------------------
  function registerMessageListener() {
    oc.thread.on("MessageAdded", function (event) {
      if (suppressAutoTrigger || isGenerating) {
        return;
      }
      const message = event && event.message;
      if (!message) {
        return;
      }
      const currentName = String(
        oc.character.name || ""
      )
        .trim()
        .toLowerCase();
      if (currentName !== UNKNOWN_NAME) {
        return;
      }
      // Ignore messages created by this generator.
      if (
        message.customData &&
        message.customData.characterGeneratorMessage
      ) {
        return;
      }
      // Ignore AI and system messages.
      if (message.author) {
        const author = String(
          message.author
        ).toLowerCase();
        if (author !== "user") {
          return;
        }
      }
      const instruction = String(
        message.content || ""
      ).trim();
      if (!instruction) {
        return;
      }
      generateCharacter(instruction, {
        mode: "full"
      });
    });
  }
  // ----------------------------------------------------------
  // Main generation controller
  // ----------------------------------------------------------
  async function generateCharacter(
    instruction = null,
    options = {}
  ) {
    if (isGenerating) {
      return;
    }
    isGenerating = true;
    const mode = options.mode || "full";
    try {
      ensureCharacterObjects();
      const resolvedInstruction =
        resolveInstruction(instruction);
      if (!resolvedInstruction) {
        throw new Error(
          "No character instruction was found. Send a message describing the character you want."
        );
      }
      saveInstruction(resolvedInstruction);
      let data;
      if (mode === "image") {
        if (!currentData) {
          throw new Error(
            "Generate a character before regenerating its image."
          );
        }
        data = clone(currentData);
        showLoading(
          "Creating a new photorealistic profile image..."
        );
        data.avatarUrl =
          await generateImageWithRetry(data);
      } else {
        showLoading(
          mode === "details"
            ? "Regenerating the character details..."
            : "Analyzing your request and creating the character..."
        );
        const generated =
          await generateTextWithRetry(
            resolvedInstruction
          );
        data = normalizeCharacterData(
          generated,
          resolvedInstruction
        );
        if (
          mode === "details" &&
          currentData &&
          currentData.avatarUrl
        ) {
          data.avatarUrl =
            currentData.avatarUrl;
        }
        if (mode === "full") {
          showLoading(
            "Creating a photorealistic profile image from the character's appearance..."
          );
          try {
            data.avatarUrl =
              await generateImageWithRetry(data);
          } catch (imageError) {
            console.error(
              "[CharacterGenerator] Image generation failed:",
              imageError
            );
            data.avatarUrl =
              currentData &&
              currentData.avatarUrl
                ? currentData.avatarUrl
                : "";
            data.imageError =
              imageError.message ||
              "Profile image generation failed.";
          }
        }
      }
      validateCharacterData(data);
      currentData = data;
      saveGeneratedData(data);
      showPreview(data);
    } catch (error) {
      console.error(
        "[CharacterGenerator] Generation failed:",
        error
      );
      showError(
        error && error.message
          ? error.message
          : String(error)
      );
    } finally {
      isGenerating = false;
    }
  }
  function resolveInstruction(instruction) {
    if (
      typeof instruction === "string" &&
      instruction.trim()
    ) {
      return instruction.trim();
    }
    if (
      currentData &&
      currentData.originalInstruction
    ) {
      return String(
        currentData.originalInstruction
      ).trim();
    }
    const saved =
      oc.character.customData.userInstruction;
    if (saved) {
      return String(saved).trim();
    }
    return "";
  }
  function saveInstruction(instruction) {
    oc.character.customData.userInstruction =
      instruction;
  }
  function saveGeneratedData(data) {
    oc.character.customData.generatedCharacterData =
      clone(data);
  }
  // ----------------------------------------------------------
  // Text generation
  // ----------------------------------------------------------
  async function generateTextWithRetry(
    instruction
  ) {
    let lastError = null;
    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        if (attempt > 1) {
          showLoading(
            `The first response was incomplete. Retrying character creation (${attempt}/3)...`
          );
        }
        const response =
          await oc.generateText({
            instruction:
              buildCharacterPrompt(
                instruction
              ),
            startWith: "NAME:",
            stopSequences: [
              "END CHARACTER"
            ]
          });
        if (!response) {
          throw new Error(
            "The text generator returned no response."
          );
        }
        const responseText =
          String(response.text || "");
        if (
          response.stopReason ===
            "error" &&
          !responseText.trim()
        ) {
          throw new Error(
            "The character text request failed."
          );
        }
        const parsed =
          parseCharacterResponse(
            responseText
          );
        validateGeneratedFields(parsed);
        return parsed;
      } catch (error) {
        lastError = error;
        console.warn(
          `[CharacterGenerator] Text attempt ${attempt} failed:`,
          error
        );
      }
    }
    throw (
      lastError ||
      new Error(
        "Character generation failed after three attempts."
      )
    );
  }
  function buildCharacterPrompt(
    instruction
  ) {
    return [
      "You are an expert character designer for immersive adult roleplay and character chat.",
      "",
      "Create only the character that the AI will portray.",
      "Do not create a role for the user.",
      "Do not write a roleplay starter, greeting, opening scene, or scenario.",
      "",
      "The character must be explicitly 12 years old or older.",
      "",
      "Infer the appropriate tone directly from the USER INSTRUCTION.",
      "Do not default to neutral unless the request itself is genuinely neutral.",
      "",
      "Possible tones include, but are not limited to:",
      "- affectionate",
      "- romantic",
      "- playful",
      "- teasing",
      "- flirtatious",
      "- mysterious",
      "- dark",
      "- intimidating",
      "- dominant",
      "- wholesome",
      "- comedic",
      "- serious",
      "- dramatic",
      "- adventurous",
      "- sensual but non-graphic",
      "",
      "Infer the genre directly from the USER INSTRUCTION.",
      "",
      `USER INSTRUCTION: ${instruction}`,
      "",
      "Return the character using this exact format:",
      "",
      "NAME: <full character name>",
      "AGE: <adult age of 12 or older>",
      "INFERRED TONE: <tone inferred from the user instruction>",
      "INFERRED GENRE: <genre inferred from the user instruction>",
      "",
      "PERSONALITY: <detailed personality in 4 to 7 sentences>",
      "",
      "SPEECH STYLE: <how the character speaks, including vocabulary, cadence, confidence, humor, accent if requested, and verbal habits>",
      "",
      "BACKGROUND: <concise but useful background that supports the character>",
      "",
      "HEIGHT: <height>",
      "BODY TYPE: <overall body type and build>",
      "BODY PROPORTIONS: <general shoulders, tit size, waist, hips, and limb proportions >",
      "POSTURE: <usual posture, movement, and physical confidence>",
      "",
      "FACE: <face shape, complexion, facial structure, lips, nose, brows, and distinctive facial features>",
      "EYES: <eye color, shape, expression, and lashes or brows where relevant>",
      "HAIR COLOR: <hair color>",
      "HAIR STYLE: <hair length, texture, cut, styling, and typical arrangement>",
      "",
      "CLOTHING: <signature clothing and overall wardrobe aesthetic>",
      "JEWELRY: <jewelry and accessories, or none>",
      "PIERCINGS: <piercings, or none>",
      "TATTOOS: <tattoos, or none>",
      "DISTINCTIVE FEATURES: <scars, freckles, beauty marks, unusual traits, or other distinguishing features>",
      "",
      "PHOTO EXPRESSION: <expression the character should have in a profile photograph>",
      "PHOTO FRAMING: <headshot, chest-up portrait, waist-up portrait, or full-body portrait>",
      "PHOTO ENVIRONMENT: <simple realistic background suited to the character>",
      "",
      "ROLE INSTRUCTION: <detailed instructions for portraying the character consistently, including personality, behavior, boundaries, conversational style, emotional reactions, and how the character should remain in character>",
      "",
      "END CHARACTER",
      "",
      "Rules:",
      "- Include every field.",
      "- Do not add Markdown headings.",
      "- Do not create a user character.",
      "- Do not create a roleplay starter.",
      "- Do not add introductory commentary.",
      "- Keep the character internally consistent.",
      "- Make the inferred tone clearly reflect the user's actual request."
    ].join("\n");
  }
  // ----------------------------------------------------------
  // Response parsing
  // ----------------------------------------------------------
  function parseCharacterResponse(
    responseText
  ) {
    let text = String(
      responseText || ""
    )
      .replace(
        /\bEND CHARACTER\b[\s\S]*$/i,
        ""
      )
      .trim();
    // Some implementations omit the
    // startWith text from response.text.
    if (
      text &&
      !/^NAME\s*:/i.test(text)
    ) {
      text = "NAME:" + text;
    }
    const fields = [
      "NAME",
      "AGE",
      "INFERRED TONE",
      "INFERRED GENRE",
      "PERSONALITY",
      "SPEECH STYLE",
      "BACKGROUND",
      "HEIGHT",
      "BODY TYPE",
      "BODY PROPORTIONS",
      "POSTURE",
      "FACE",
      "EYES",
      "HAIR COLOR",
      "HAIR STYLE",
      "CLOTHING",
      "JEWELRY",
      "PIERCINGS",
      "TATTOOS",
      "DISTINCTIVE FEATURES",
      "PHOTO EXPRESSION",
      "PHOTO FRAMING",
      "PHOTO ENVIRONMENT",
      "ROLE INSTRUCTION"
    ];
    const values = {};
    fields.forEach(function (
      field,
      index
    ) {
      const followingFields =
        fields.slice(index + 1);
      values[field] = extractField(
        text,
        field,
        followingFields
      );
    });
    return {
      characterName:
        values["NAME"],
      characterAge:
        values["AGE"],
      inferredTone:
        values["INFERRED TONE"],
      inferredGenre:
        values["INFERRED GENRE"],
      personality:
        values["PERSONALITY"],
      speechStyle:
        values["SPEECH STYLE"],
      background:
        values["BACKGROUND"],
      height:
        values["HEIGHT"],
      bodyType:
        values["BODY TYPE"],
      bodyProportions:
        values["BODY PROPORTIONS"],
      posture:
        values["POSTURE"],
      face:
        values["FACE"],
      eyes:
        values["EYES"],
      hairColor:
        values["HAIR COLOR"],
      hairStyle:
        values["HAIR STYLE"],
      clothing:
        values["CLOTHING"],
      jewelry:
        values["JEWELRY"],
      piercings:
        values["PIERCINGS"],
      tattoos:
        values["TATTOOS"],
      distinctiveFeatures:
        values[
          "DISTINCTIVE FEATURES"
        ],
      photoExpression:
        values["PHOTO EXPRESSION"],
      photoFraming:
        values["PHOTO FRAMING"],
      photoEnvironment:
        values["PHOTO ENVIRONMENT"],
      roleInstruction:
        values["ROLE INSTRUCTION"]
    };
  }
  function extractField(
    text,
    field,
    followingFields
  ) {
    const escapedField =
      escapeRegExp(field);
    let endPattern = "$";
    if (followingFields.length) {
      endPattern =
        "(?=\\n\\s*(?:" +
        followingFields
          .map(escapeRegExp)
          .join("|") +
        ")\\s*:|$)";
    }
    const regex = new RegExp(
      "(?:^|\\n)\\s*" +
        escapedField +
        "\\s*:\\s*([\\s\\S]*?)" +
        endPattern,
      "i"
    );
    const match = text.match(regex);
    return match
      ? cleanText(match[1])
      : "";
  }
  function cleanText(value) {
    return String(value || "")
      .trim()
      .replace(/\n{3,}/g, "\n\n");
  }
  function escapeRegExp(value) {
    return String(value).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
  }
  // ----------------------------------------------------------
  // Data normalization and validation
  // ----------------------------------------------------------
  function normalizeCharacterData(
    generated,
    instruction
  ) {
    return {
      characterName:
        generated.characterName,
      characterAge:
        generated.characterAge,
      inferredTone:
        generated.inferredTone,
      inferredGenre:
        generated.inferredGenre,
      personality:
        generated.personality,
      speechStyle:
        generated.speechStyle,
      background:
        generated.background,
      height:
        generated.height,
      bodyType:
        generated.bodyType,
      bodyProportions:
        generated.bodyProportions,
      posture:
        generated.posture,
      face:
        generated.face,
      eyes:
        generated.eyes,
      hairColor:
        generated.hairColor,
      hairStyle:
        generated.hairStyle,
      clothing:
        generated.clothing,
      jewelry:
        generated.jewelry,
      piercings:
        generated.piercings,
      tattoos:
        generated.tattoos,
      distinctiveFeatures:
        generated.distinctiveFeatures,
      photoExpression:
        generated.photoExpression,
      photoFraming:
        generated.photoFraming,
      photoEnvironment:
        generated.photoEnvironment,
      roleInstruction:
        generated.roleInstruction,
      avatarUrl: "",
      originalInstruction:
        instruction,
      imageError: ""
    };
  }
  function validateGeneratedFields(
    data
  ) {
    const required = [
      "characterName",
      "characterAge",
      "inferredTone",
      "inferredGenre",
      "personality",
      "speechStyle",
      "height",
      "bodyType",
      "face",
      "eyes",
      "hairColor",
      "hairStyle",
      "clothing",
      "photoExpression",
      "photoFraming",
      "roleInstruction"
    ];
    const missing =
      required.filter(function (
        field
      ) {
        return !String(
          data[field] || ""
        ).trim();
      });
    if (missing.length) {
      throw new Error(
        "The generated response was missing: " +
          missing.join(", ")
      );
    }
  }
  function validateCharacterData(
    data
  ) {
    validateGeneratedFields(data);
    if (
      !data.originalInstruction
    ) {
      data.originalInstruction =
        resolveInstruction(null);
    }
  }
  // ----------------------------------------------------------
  // Photorealistic image generation
  // ----------------------------------------------------------
  async function generateImageWithRetry(
    data
  ) {
    let lastError = null;
    const prompt =
      buildPhotorealisticImagePrompt(
        data
      );
    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        if (attempt > 1) {
          showLoading(
            `The image failed. Retrying the photorealistic portrait (${attempt}/3)...`
          );
        }
        const result =
          await oc.textToImage({
            prompt,
            negativePrompt: [
              "illustration",
              "digital painting",
              "anime",
              "cartoon",
              "comic",
              "3d render",
              "cgi",
              "plastic skin",
              "airbrushed skin",
              "child",
              "minor",
              "underage",
              "young-looking",
              "blurry",
              "out of focus",
              "low resolution",
              "low quality",
              "bad anatomy",
              "deformed face",
              "asymmetrical eyes",
              "extra limbs",
              "extra fingers",
              "missing fingers",
              "distorted hands",
              "duplicate person",
              "multiple people",
              "text",
              "caption",
              "logo",
              "watermark",
              "frame",
              "border"
            ].join(", ")
          });
        if (
          !result ||
          !result.dataUrl
        ) {
          throw new Error(
            "The image generator returned no image."
          );
        }
        return await resizeImage(
          result.dataUrl,
          500
        );
      } catch (error) {
        lastError = error;
        console.warn(
          `[CharacterGenerator] Image attempt ${attempt} failed:`,
          error
        );
      }
    }
    throw (
      lastError ||
      new Error(
        "Profile image generation failed."
      )
    );
  }
  function buildPhotorealisticImagePrompt(
    data
  ) {
    const ageNum = Number(data.characterAge);
    const agePhrase = Number.isFinite(ageNum) && ageNum >= 18
      ? `one adult person, age ${data.characterAge}`
      : "one adult person with mature 18+ appearance";
    return [
      "Photorealistic professional portrait photograph",
      agePhrase,
      data.characterName,
      `inferred tone: ${data.inferredTone}`,
      `genre aesthetic: ${data.inferredGenre}`,
      `height and presence: ${data.height}`,
      `body type: ${data.bodyType}`,
      `body proportions: ${data.bodyProportions}`,
      `posture: ${data.posture}`,
      `face: ${data.face}`,
      `eyes: ${data.eyes}`,
      `hair color: ${data.hairColor}`,
      `hairstyle: ${data.hairStyle}`,
      `clothing: ${data.clothing}`,
      `jewelry and accessories: ${data.jewelry}`,
      `piercings: ${data.piercings}`,
      `tattoos: ${data.tattoos}`,
      `distinctive features: ${data.distinctiveFeatures}`,
      `facial expression: ${data.photoExpression}`,
      `portrait framing: ${data.photoFraming}`,
      `background: ${data.photoEnvironment}`,
      "single subject",
      "real human skin texture",
      "natural pores",
      "realistic facial proportions",
      "realistic hair strands",
      "realistic fabric texture",
      "professional portrait photography",
      "85mm portrait lens",
      "shallow depth of field",
      "soft natural cinematic lighting",
      "sharp eyes",
      "high dynamic range",
      "highly detailed",
      "true-to-life photography",
      "not an illustration"
    ]
      .filter(Boolean)
      .join(", ");
  }
  async function resizeImage(
    dataUrl,
    width
  ) {
    const response =
      await fetch(dataUrl);
    if (!response.ok) {
      throw new Error(
        "The generated image could not be loaded."
      );
    }
    const blob =
      await response.blob();
    const bitmap =
      await createImageBitmap(blob);
    const canvas =
      document.createElement(
        "canvas"
      );
    canvas.width = width;
    canvas.height = Math.max(
      1,
      Math.round(
        (bitmap.height /
          bitmap.width) *
          width
      )
    );
    const context =
      canvas.getContext("2d");
    if (!context) {
      throw new Error(
        "Canvas image resizing is unavailable."
      );
    }
    context.drawImage(
      bitmap,
      0,
      0,
      canvas.width,
      canvas.height
    );
    if (
      typeof bitmap.close ===
      "function"
    ) {
      bitmap.close();
    }
    return canvas.toDataURL(
      "image/jpeg",
      0.94
    );
  }
  // ----------------------------------------------------------
  // Preview
  // ----------------------------------------------------------
  function showPreview(data) {
    currentData = data;
    saveGeneratedData(data);
    const imageSection =
      data.avatarUrl
        ? [
            `<div style="text-align:center;margin:12px 0 20px;">`,
            `<img src="${escapeAttribute(data.avatarUrl)}" style="display:block;max-width:320px;width:100%;height:auto;margin:0 auto;border-radius:14px;">`,
            `<div style="opacity:0.7;margin-top:8px;">Proposed profile image</div>`,
            `</div>`
          ].join("")
        : [
            `<div style="padding:12px;border:1px solid rgba(128,128,128,0.35);border-radius:10px;margin:12px 0;">`,
            `<strong>Profile image unavailable.</strong>`,
            data.imageError
              ? `<br>${escapeHtml(data.imageError)}`
              : "",
            `<br><span style="opacity:0.7;">Use the Regenerate Image button below to try again.</span>`,
            `</div>`
          ].join("");
    const content = [
      `<span style="opacity:0.7;">Preview the character and proposed profile image before applying.</span>`,
      "",
      imageSection,
      "",
      `**${escapeText(data.characterName)}**`,
      "",
      `**Age:** ${escapeText(data.characterAge)}`,
      "",
      `**Inferred tone:** ${escapeText(data.inferredTone)}`,
      "",
      `**Inferred genre:** ${escapeText(data.inferredGenre)}`,
      "",
      `**Personality:**`,
      escapeText(data.personality),
      "",
      `**Speech style:**`,
      escapeText(data.speechStyle),
      "",
      `**Background:**`,
      escapeText(data.background),
      "",
      `**Physical profile**`,
      "",
      `**Height:** ${escapeText(data.height)}`,
      "",
      `**Body type:** ${escapeText(data.bodyType)}`,
      "",
      `**Body proportions:** ${escapeText(data.bodyProportions)}`,
      "",
      `**Posture:** ${escapeText(data.posture)}`,
      "",
      `**Face:** ${escapeText(data.face)}`,
      "",
      `**Eyes:** ${escapeText(data.eyes)}`,
      "",
      `**Hair color:** ${escapeText(data.hairColor)}`,
      "",
      `**Hair style:** ${escapeText(data.hairStyle)}`,
      "",
      `**Clothing:** ${escapeText(data.clothing)}`,
      "",
      `**Jewelry:** ${escapeText(data.jewelry)}`,
      "",
      `**Piercings:** ${escapeText(data.piercings)}`,
      "",
      `**Tattoos:** ${escapeText(data.tattoos)}`,
      "",
      `**Distinctive features:** ${escapeText(data.distinctiveFeatures)}`,
      "",
      `<!--hidden-from-ai-start-->`,
      `<button onclick="CharacterGenerator.apply()">✅ Apply Character</button>`,
      `<button onclick="CharacterGenerator.edit()">✏️ Edit Details</button>`,
      `<button onclick="CharacterGenerator.regenerateImage()">📷 Regenerate Image</button>`,
      `<button onclick="CharacterGenerator.regenerateDetails()">🔄 Regenerate Details</button>`,
      `<button onclick="CharacterGenerator.regenerateAll()">🎲 Regenerate Everything</button>`,
      `<button onclick="CharacterGenerator.cancel()">Cancel</button>`,
      `<!--hidden-from-ai-end-->`
    ].join("\n");
    replaceMessages([
      {
        author: "system",
        name: "Character Preview",
        content,
        expectsReply: false,
        avatar: {
          size: 0
        },
        customData: {
          characterGeneratorMessage: true,
          type: "preview"
        }
      }
    ]);
  }
  // ----------------------------------------------------------
  // Apply character
  // ----------------------------------------------------------
  function applyCharacterData(data) {
    ensureCharacterObjects();
    oc.character.name =
      String(
        data.characterName
      ).trim();
    oc.character.roleInstruction =
      buildFinalRoleInstruction(data);
    oc.character.initialMessages = [];
    if (data.avatarUrl) {
      oc.character.avatar.url =
        data.avatarUrl;
    }
    saveGeneratedData(data);
  }
  function buildFinalRoleInstruction(
    data
  ) {
    return [
      `You are ${data.characterName}, an adult character who is ${data.characterAge} years old.`,
      "",
      `Tone: ${data.inferredTone}`,
      `Genre: ${data.inferredGenre}`,
      "",
      "Personality:",
      data.personality,
      "",
      "Speech style:",
      data.speechStyle,
      "",
      "Background:",
      data.background,
      "",
      "Physical appearance:",
      `Height: ${data.height}`,
      `Body type: ${data.bodyType}`,
      `Body proportions: ${data.bodyProportions}`,
      `Posture: ${data.posture}`,
      `Face: ${data.face}`,
      `Eyes: ${data.eyes}`,
      `Hair color: ${data.hairColor}`,
      `Hair style: ${data.hairStyle}`,
      `Clothing: ${data.clothing}`,
      `Jewelry: ${data.jewelry}`,
      `Piercings: ${data.piercings}`,
      `Tattoos: ${data.tattoos}`,
      `Distinctive features: ${data.distinctiveFeatures}`,
      "",
      "Character portrayal instructions:",
      data.roleInstruction,
      "",
      "Remain consistent with the character's established personality, appearance, tone, background, and manner of speaking. Do not create or assign a role to the user unless the user explicitly requests one later."
    ].join("\n");
  }
  function showSuccess(data) {
    const imageSection =
      data.avatarUrl
        ? [
            `<div style="text-align:center;margin:12px 0 20px;">`,
            `<img src="${escapeAttribute(data.avatarUrl)}" style="display:block;max-width:260px;width:100%;height:auto;margin:0 auto;border-radius:14px;">`,
            `</div>`
          ].join("")
        : "";
    const content = [
      `<span style="opacity:0.7;">Character successfully created and applied.</span>`,
      "",
      imageSection,
      "",
      `**${escapeText(data.characterName)}**`,
      "",
      `**Age:** ${escapeText(data.characterAge)}`,
      "",
      `**Tone:** ${escapeText(data.inferredTone)}`,
      "",
      `**Genre:** ${escapeText(data.inferredGenre)}`,
      "",
      `**Personality:**`,
      escapeText(data.personality),
      "",
      `**Appearance:**`,
      [
        data.height,
        data.bodyType,
        data.bodyProportions,
        data.face,
        data.eyes,
        `${data.hairColor}; ${data.hairStyle}`,
        data.clothing,
        data.jewelry
      ]
        .filter(Boolean)
        .map(escapeText)
        .join("<br>"),
      "",
      `<!--hidden-from-ai-start-->`,
      `<button onclick="CharacterGenerator.edit()">✏️ Edit Details</button>`,
      `<button onclick="CharacterGenerator.regenerateImage()">📷 Regenerate Image</button>`,
      `<button onclick="CharacterGenerator.regenerateDetails()">🔄 Regenerate Details</button>`,
      `<button onclick="CharacterGenerator.regenerateAll()">🎲 Regenerate Everything</button>`,
      `<button onclick="CharacterGenerator.deleteIntro()">🗑️ Delete This Intro</button>`,
      `<!--hidden-from-ai-end-->`
    ].join("\n");
    replaceMessages([
      {
        author: "system",
        name: "Introduction",
        content,
        expectsReply: false,
        avatar: {
          size: 0
        },
        customData: {
          characterGeneratorMessage: true,
          type: "success"
        }
      }
    ]);
  }
  // ----------------------------------------------------------
  // Editing
  // ----------------------------------------------------------
  api.edit = function () {
    if (!currentData) {
      showError(
        "No generated character is available to edit."
      );
      return;
    }
    editField(
      "characterName",
      "Character name:"
    );
    editField(
      "characterAge",
      "Character age:"
    );
    editField(
      "inferredTone",
      "Character tone:"
    );
    editField(
      "inferredGenre",
      "Character genre:"
    );
    editField(
      "personality",
      "Personality:"
    );
    editField(
      "speechStyle",
      "Speech style:"
    );
    editField(
      "background",
      "Background:"
    );
    editField(
      "height",
      "Height:"
    );
    editField(
      "bodyType",
      "Body type:"
    );
    editField(
      "bodyProportions",
      "Body proportions:"
    );
    editField(
      "posture",
      "Posture:"
    );
    editField(
      "face",
      "Face:"
    );
    editField(
      "eyes",
      "Eyes:"
    );
    editField(
      "hairColor",
      "Hair color:"
    );
    editField(
      "hairStyle",
      "Hair style:"
    );
    editField(
      "clothing",
      "Clothing:"
    );
    editField(
      "jewelry",
      "Jewelry:"
    );
    editField(
      "piercings",
      "Piercings:"
    );
    editField(
      "tattoos",
      "Tattoos:"
    );
    editField(
      "distinctiveFeatures",
      "Distinctive features:"
    );
    editField(
      "photoExpression",
      "Profile-photo expression:"
    );
    editField(
      "photoFraming",
      "Profile-photo framing:"
    );
    editField(
      "photoEnvironment",
      "Profile-photo environment:"
    );
    editField(
      "roleInstruction",
      "Character behavior and role instructions:"
    );
    saveGeneratedData(currentData);
    showPreview(currentData);
  };
  function editField(
    field,
    message
  ) {
    const existing =
      currentData[field] || "";
    const edited = prompt(
      message,
      existing
    );
    if (
      edited !== null &&
      String(edited).trim()
    ) {
      currentData[field] =
        String(edited).trim();
    }
  }
  // ----------------------------------------------------------
  // Public actions
  // ----------------------------------------------------------
  api.apply = function () {
    if (!currentData) {
      showError(
        "No generated character is available."
      );
      return;
    }
    try {
      validateCharacterData(
        currentData
      );
      applyCharacterData(
        currentData
      );
      showSuccess(
        currentData
      );
    } catch (error) {
      showError(error.message);
    }
  };
  api.regenerateImage =
    function () {
      return generateCharacter(
        null,
        {
          mode: "image"
        }
      );
    };
  api.regenerateDetails =
    function () {
      return generateCharacter(
        null,
        {
          mode: "details"
        }
      );
    };
  api.regenerateAll =
    function () {
      return generateCharacter(
        null,
        {
          mode: "full"
        }
      );
    };
  api.generate =
    generateCharacter;
  api.regenerate =
    generateCharacter;
  api.start = function (
    instruction
  ) {
    return generateCharacter(
      instruction,
      {
        mode: "full"
      }
    );
  };
  api.cancel = function () {
    replaceMessages([]);
  };
  api.deleteIntro = function () {
    replaceMessages([]);
  };
  // ----------------------------------------------------------
  // Loading and errors
  // ----------------------------------------------------------
  function showLoading(message) {
    replaceMessages([
      {
        author: "ai",
        name: "Unknown",
        hiddenFrom: ["ai"],
        content:
          escapeHtml(message) +
          `<br><br><progress style="width:90px"></progress>`,
        expectsReply: false,
        avatar: {
          url: UNKNOWN_AVATAR
        },
        customData: {
          characterGeneratorMessage: true,
          isPleaseWaitMessage: true
        }
      }
    ]);
  }
  function showError(message) {
    replaceMessages([
      {
        author: "system",
        name: "Character Generator Error",
        hiddenFrom: ["ai"],
        content: [
          `<strong>Character generation failed.</strong>`,
          "",
          escapeHtml(message),
          "",
          `<button onclick="CharacterGenerator.regenerateAll()">Try Again</button>`
        ].join("<br>"),
        expectsReply: false,
        avatar: {
          url: UNKNOWN_AVATAR
        },
        customData: {
          characterGeneratorMessage: true,
          type: "error"
        }
      }
    ]);
  }
  function replaceMessages(
    messages
  ) {
    suppressAutoTrigger = true;
    try {
      oc.thread.messages =
        messages;
    } finally {
      setTimeout(
        function () {
          suppressAutoTrigger =
            false;
        },
        0
      );
    }
  }
  // ----------------------------------------------------------
  // Utilities
  // ----------------------------------------------------------
  function clone(value) {
    return JSON.parse(
      JSON.stringify(value)
    );
  }
  function escapeHtml(value) {
    return String(
      value === null ||
      value === undefined
        ? ""
        : value
    )
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function escapeAttribute(value) {
    return escapeHtml(value);
  }
  function escapeText(value) {
    return escapeHtml(value)
      .replace(/\n/g, "<br>");
  }
  return api;
})();
