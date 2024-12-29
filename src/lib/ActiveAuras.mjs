import { AAHelpers } from "./AAHelpers.mjs";
import { AAMeasure } from "./AAMeasure.mjs";
import { AATemplates } from "./AATemplates.js";
import Logger from "./Logger.mjs";

export class ActiveAuras {
  /**
   *
   * @param {Token} movedToken - optional value for further extension, currently unused
   * Locate all auras on the canvas, create map of tokens to update, update tokens
   */
  static async MainAura(movedToken, source, sceneID) {
    Logger.debug("MainAura Params", { movedToken, source, sceneID });
    const perfStart = CONFIG.debug.AA ? performance.now() : undefined;

    if (typeof movedToken?.documentName !== "string") movedToken = movedToken?.document ?? undefined;
    if (!CONFIG.AA.GM) return;
    const sceneCombat = game.combats.filter((c) => c.scene?.id === sceneID);
    if (game.settings.get("ActiveAuras", "combatOnly") && !sceneCombat[0]?.started) {
      Logger.debug("Active Auras not active when not in combat");
      return;
    }
    if (sceneID !== canvas.id) {
      ui.notifications.warn(
        "An update was called on a non viewed scene, auras will be updated when you return to that scene"
      );
      return;
    }

    let updateTokens = canvas.tokens.placeables;
    let auraTokenId;

    if (movedToken !== undefined) {
      if (AAHelpers.IsAuraToken(movedToken.id, sceneID)) {
        auraTokenId = movedToken.id;
      }
      else if (foundry.utils.getProperty(movedToken, "flags.token-attacher")) {
        Logger.debug("ActiveAuras: token attacher movement");
      }
      else {
        updateTokens = [canvas.tokens.get(movedToken.id)];
      }
    }

    const effectMap = ActiveAuras.UpdateAllTokens(new Map(), updateTokens, auraTokenId);

    if (CONFIG.debug.AA) {
      Logger.info(`Active Auras Find Auras took ${performance.now() - perfStart} ms, FPS:${Math.round(canvas.app.ticker.FPS)}`);
    }

    for (const mapEffect of effectMap) {
      effectMap.set(mapEffect[0], { add: mapEffect[1].add, token: mapEffect[1].token, effect: mapEffect[1].effect.data });
    }
    Logger.debug("Active Aura Effect map", effectMap);

    // Loop over the map to remove any "add.false" entries where a "add.true" is present,
    // prevents odd ordering from removing auras when in range of 2 or more of the same aura
    // Where 2 of the same type of aura are present, choose the higher of the 2 values to update too
    effectMap.forEach((value, key, map1) => {
      const iterator1 = map1[Symbol.iterator]();
      for (const m of iterator1) {
        if (m[0] === key) continue;

        if (m[1].effect.name === value.effect.name  && m[1].add === true && value.add === true) {
          for (let e = 0; e < m[1].effect.changes.length; e++) {
            if (typeof parseInt(m[1].effect.changes[e].value) !== "number") continue;
            if (value.effect.changes.length < e) continue;
            const oldEffectValue = parseInt(value.effect.changes[e]?.value ?? 0);
            const newEffectValue = parseInt(m[1].effect.changes[e].value);
            if (oldEffectValue < newEffectValue) {
              map1.delete(key);
            }
          }
        } else if (
          m[1].effect.name === value.effect.name
          && (m[1].add === true || value.add === true)
          && m[1].token.id === value.token.id
        ) {
          if (value.add === false) effectMap.delete(key);
        }
      }
    });

    for (const update of effectMap) {
      if (update[1].add) {
        await ActiveAuras.CreateActiveEffect(update[1].token.id, update[1].effect);
      } else {
        await ActiveAuras.RemoveActiveEffects(update[1].token.id, update[1].effect.origin);
      }
    }
    if (CONFIG.debug.AA) {
      Logger.debug(
        `Active Auras Main Function took ${performance.now() - perfStart} ms, FPS:${Math.round(canvas.app.ticker.FPS)}`
      );
    }
  }

  /**
   * Test individual token against aura array
   * @param {Map} map - empty map to populate
   * @param {Array} auraEffectArray - array of auras to test against
   * @param {Token} canvasToken - single token to test
   */
  static UpdateToken(map, canvasToken, tokenId) {
    if (canvasToken.document.flags["multilevel-tokens"]) return;
    if (canvasToken.actor === null) return;
    if (canvasToken.actor.type == "vehicle" || canvasToken.actor.type == "group") return;
    let tokenAlignment;
    if (game.system.id === "dnd5e" || game.system.id === "sw5e") {
      try {
        tokenAlignment = canvasToken.actor?.system?.details?.alignment?.toLowerCase();
      } catch (error) {
        Logger.error(["ActiveAuras: the token has an unreadable alignment", canvasToken]);
      }
    }
    const MapKey = canvasToken.scene.id;
    let MapObject = CONFIG.AA.Map.get(MapKey);
    let checkEffects = MapObject.effects;
    //Check for other types of X aura if the aura token is moved
    if (tokenId && canvasToken.id !== tokenId) {
      checkEffects = checkEffects.filter((i) => i.entityId === tokenId);
      let duplicateEffect = [];
      checkEffects.forEach((e) =>
        (duplicateEffect = MapObject.effects.filter((i) => i.data?.name === e.data?.name && i.entityId !== tokenId))
      );
      checkEffects = checkEffects.concat(duplicateEffect);
    }

    // if (CONFIG.debug.AA) console.log("ActiveAura UpdateToken Map details", { MapKey, MapObject, checkEffects, tokenAlignment})

    for (const auraEffect of checkEffects) {
      const auraTargets = auraEffect.data.flags?.ActiveAuras?.aura;

      const { radius, height, hostile, wildcard, extra } = (auraEffect.data.flags?.ActiveAuras ?? {});
      let { type, alignment, customCheck, wallsBlock } = (auraEffect.data.flags?.ActiveAuras ?? {});
      alignment = alignment?.toLowerCase() ?? "";
      customCheck = customCheck?.trim() ?? "";
      type = type?.toLowerCase() ?? "";
      wallsBlock = wallsBlock?.toLowerCase() ?? "system";

      if (alignment && !tokenAlignment.includes(alignment) && !tokenAlignment.includes("any")) continue;
      if (wallsBlock !== "system") {
        wallsBlock = wallsBlock === "true";
      } else {
        wallsBlock = game.settings.get("ActiveAuras", "wall-block");
      }

      let auraEntity, distance;

      const rename = foundry.utils.getProperty(auraEffect.data, "flags.ActiveAuras.nameOverride");
      const effectName = (rename && rename.trim() !=="") ? rename : auraEffect.data.name;

      switch (auraEffect.entityType) {
        //{data: testEffect.data, parentActorLink :testEffect.parent.data.token.actorLink, parentActorId : testEffect.parent._id, tokenId: testToken.id, templateId: template._id, }
        case "token":
          {
            if (auraEffect.parentActorLink) {
              const auraTokenArray = game.actors.get(auraEffect.parentActorId).getActiveTokens();
              if (auraTokenArray.length > 1) {
                auraEntity = auraTokenArray[0];
                Logger.error("AA: Duplicate Linked Tokens detected, defaulting to first token.");
              } else auraEntity = auraTokenArray[0];
            } else auraEntity = canvas.tokens.get(auraEffect.entityId);

            if (auraEntity.id === canvasToken.id) continue;

            if (
              !AAHelpers.DispositionCheck(
                auraTargets,
                auraEntity.document.disposition,
                canvasToken.document.disposition
              )
            )
              continue;
            if (type && !AAHelpers.CheckTypes(canvasToken, type)) continue;
            if (hostile && canvasToken.id !== game.combats.active?.current.tokenId) continue;
            if (game.system.id === "swade" && !AAHelpers.Wildcard(canvasToken, wildcard, extra)) continue;

            const tokenRadius = AAHelpers.EvaluateRollString({ rollString: radius, token: auraEntity });
            const shape = AATemplates.getAuraShape(auraEntity, tokenRadius);
            distance = AAMeasure.inAura(
              canvasToken,
              auraEntity,
              wallsBlock,
              height,
              tokenRadius,
              shape
            );
          }
          break;
        case "template":
          {
            auraEntity = canvas.templates.get(auraEffect.entityId);

            if (type && !AAHelpers.CheckTypes(canvasToken, type)) continue;
            if (hostile && canvasToken.id !== game.combats.active.current.tokenId) return;
            if (auraEffect.casterDisposition) {
              if (!AAHelpers.DispositionCheck(auraTargets, auraEffect.casterDisposition, canvasToken.document.disposition))
                continue;
            }
            // const shape = AATemplates.getTemplateShape(auraEntity);
            let templateDetails = auraEntity;
            //templateDetails.shape = shape
            distance = AAMeasure.isTokenInside(
              templateDetails,
              canvasToken,
              wallsBlock
            );
          }
          break;
        case "drawing":
          {
            auraEntity = canvas.drawings.get(auraEffect.entityId);
            if (type && !AAHelpers.CheckTypes(canvasToken, type)) continue;
            if (hostile && canvasToken.id !== game.combats.active.current.tokenId) return;

            const shape = AATemplates.getDrawingShape(auraEntity);
            distance = AAMeasure.inAura(
              canvasToken,
              auraEntity,
              wallsBlock,
              height,
              radius,
              shape
            );

          }
          break;
      }
      const MapKey = auraEffect.data.origin + "-" + canvasToken.id + "-" + auraEntity.id + "-" + effectName;
      MapObject = map.get(MapKey);

      if (distance && !auraEffect.data.flags?.ActiveAuras?.Paused) {
        if (customCheck && !AAHelpers.evaluateCustomCheck(canvasToken, customCheck, auraEntity)) continue;
        if (MapObject) {
          MapObject.add = true;
        } else {
          map.set(MapKey, { add: true, token: canvasToken, effect: auraEffect });
        }
      } else if (
        !MapObject?.add
        && Array.from(canvasToken.document.actor?.allApplicableEffects() ?? []).some(
          (e) => e.origin === auraEffect.data.origin && e.name === effectName
        )
      ) {
        if (MapObject) {
          MapObject.add = false;
        } else {
          map.set(MapKey, { add: false, token: canvasToken, effect: auraEffect });
        }
      }
    }
    return map;
  }

  /**
   * Loop over canvas tokens for individual tests
   * @param {Map} map - empty map to populate
   * @param {Array} auraEffectArray - array of auras to test against
   * @param {Token} tokens - array of tokens to test against
   */
  static UpdateAllTokens(map, tokens, tokenId) {
    for (const canvasToken of tokens) {
      // if (CONFIG.debug.AA) console.log("Updating canvas token", {canvasToken, tokenId});
      ActiveAuras.UpdateToken(map, canvasToken, tokenId);
    }
    return map;
  }

  /**
   *
   * @param {Token} token - token to apply effect too
   * @param {ActiveEffect} effectData - effect data to generate effect
   */
  static async CreateActiveEffect(tokenID, oldEffectData) {
    const token = canvas.tokens.get(tokenID);

    const rename = foundry.utils.getProperty(oldEffectData, "flags.ActiveAuras.nameOverride");
    const effectName = (rename && rename.trim() !=="") ? rename : oldEffectData.name;

    const duplicateEffect = Array.from(token.document.actor.allApplicableEffects()).find((e) =>
      e.origin === oldEffectData.origin && e.name === effectName
    );
    if (foundry.utils.getProperty(duplicateEffect, "flags.ActiveAuras.isAura")) return;
    if (duplicateEffect) {
      if (duplicateEffect.origin === oldEffectData.origin) return;
      if (JSON.stringify(duplicateEffect.changes) === JSON.stringify(oldEffectData.changes)) return;
      else await ActiveAuras.RemoveActiveEffects(tokenID, oldEffectData.origin);
    }
    let effectData = foundry.utils.duplicate(oldEffectData);
    effectData.name = effectName;

    if (effectData.flags.ActiveAuras.onlyOnce) {
      const AAID = oldEffectData.origin.replaceAll(".", "");
      if (token.document.flags.ActiveAuras?.[AAID]) return;
      else await token.document.setFlag("ActiveAuras", AAID, true);
    }
    if (effectData.flags.ActiveAuras?.isMacro) {
      // eslint-disable-next-line no-unused-vars
      for (let [changeIndex, change] of effectData.changes.entries()) {
        let newValue = change.value;
        if (change.key.startsWith("macro.")) {
          if (typeof newValue === "string") {
            newValue = [newValue];

            newValue = newValue.map((val) => {
              if (typeof val === "string" && val.includes("@@token")) {
                let re = /([\s]*@@token)/gms;
                return val.replaceAll(re, " @token");
              } else if (typeof val === "string" && val.includes("@token")) {
                let re = /([\s]*@token)/gms;
                return val.replaceAll(re, ` ${token.id}`);
              }
              return val;
            });
            if (typeof change.value === "string") {
              change.value = newValue[0];
            } else {
              change.value = newValue;
            }
          }
        }
      }
    }
    ["ignoreSelf", "hidden", "height", "alignment", "type", "aura", "radius", "isAura", "height"].forEach(
      (e) => delete effectData.flags.ActiveAuras[e]
    );
    if (
      effectData.flags.ActiveAuras.time !== "None"
      && effectData.flags.ActiveAuras.time !== undefined
      && game.modules.get("dae")?.active
    ) {
      effectData.flags.dae?.specialDuration?.push(effectData.flags.ActiveAuras.time);
    }

    if (!token.actor.getEmbeddedCollection("ActiveEffect").some((x) => (x.img == effectData.img))) {
        await token.actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    }
    Logger.debug(game.i18n.format("ACTIVEAURAS.ApplyLog", { effectDataName: effectData.name, tokenName: token.name, effectData }));
  }

  /**
   * @param {String} tokenID - token instance to remove effect from
   * @param {String} effectOrigin - origin of effect to remove
   */
  static async RemoveActiveEffects(tokenID, effectOrigin) {
    const token = canvas.tokens.get(tokenID);
    const tokenEffects = Array.from(token.actor?.allApplicableEffects() ?? []);
    for (const tokenEffect of tokenEffects) {
      if (tokenEffect.origin === effectOrigin && tokenEffect.flags?.ActiveAuras?.applied === true) {
        try {
          if (token.actor.getEmbeddedDocument("ActiveEffect", tokenEffect.id)) {
            Logger.debug("RemoveActiveEffects", { token, tokenEffects: tokenEffect });
            await token.actor.deleteEmbeddedDocuments("ActiveEffect", [tokenEffect.id]);
          }
        } catch (err) {
          Logger.error("ERROR CAUGHT in RemoveActiveEffects", err);
        } finally {
          Logger.debug(
            game.i18n.format("ACTIVEAURAS.RemoveLog", { effectDataName: effectOrigin, tokenName: token.name })
          );
        }
      }
    }
  }

  static async movementUpdate(token) {
    let MapObject = CONFIG.AA.Map.get(token.parent.id);
    if (!MapObject || MapObject?.effects.length < 1) return;
    Logger.debug("movement, main aura");
    await ActiveAuras.MainAura(token, "movement update", token.parent.id);
  }
}
