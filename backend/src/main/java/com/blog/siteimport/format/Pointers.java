package com.blog.siteimport.format;

import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Small helpers over object-only JSON pointers ({@code /hero/headline}); array indexes are never addressed. */
public final class Pointers {

    private Pointers() {}

    /** Sets the value at the pointer, creating the objects on the way. */
    public static void set(ObjectNode root, String pointer, JsonNode value) {
        String[] parts = pointer.substring(1).split("/");
        ObjectNode node = root;
        for (int i = 0; i < parts.length - 1; i++) {
            JsonNode next = node.get(parts[i]);
            node = next instanceof ObjectNode object ? object : node.putObject(parts[i]);
        }
        node.set(parts[parts.length - 1], value);
    }

    /** Copies {@code patch} onto {@code target}: objects merge field by field, everything else (lists included) replaces. */
    public static void merge(ObjectNode target, ObjectNode patch) {
        for (Map.Entry<String, JsonNode> entry : patch.properties()) {
            JsonNode existing = target.get(entry.getKey());
            if (existing instanceof ObjectNode existingObject && entry.getValue() instanceof ObjectNode patchObject) {
                merge(existingObject, patchObject);
            } else {
                target.set(entry.getKey(), entry.getValue().deepCopy());
            }
        }
    }
}
