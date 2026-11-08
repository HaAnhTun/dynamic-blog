package com.blog.postimport.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The manifest of an apply: the one text part of the request, a JSON array with one item per file part in upload order. An item
 * holds the SHA-256 of the file the person previewed, whether the file is selected and the opaque state the preview gave it
 * (null for a file in error or unchanged). File names are not in it. Every refusal is 400 {@code POST_IMPORT_INVALID_FILE} and
 * says what is wrong with the manifest, never what is in it.
 */
final class PostManifest {

    /** One manifest item; {@code state} is null when the preview gave the file none. */
    record Item(String sha256, boolean selected, String state) {}

    /** A manifest of 20 items is below 10 KiB; this only keeps a hostile part cheap to read. */
    static final int MAX_CHARS = 64 * 1024;

    /** The longest preview state accepted (a state is about 170 characters). */
    static final int MAX_STATE_CHARS = 512;

    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    private PostManifest() {}

    /**
     * @param json the text part, null when absent
     * @param files how many file parts the request has
     */
    static List<Item> parse(ObjectMapper mapper, String json, int files) {
        if (json == null || json.isBlank()) {
            throw invalid("The manifest is missing");
        }
        if (json.length() > MAX_CHARS) {
            throw invalid("The manifest is too large");
        }
        JsonNode root;
        try {
            root = mapper.readTree(json);
        } catch (JacksonException e) {
            throw invalid("The manifest is not valid JSON");
        }
        if (root == null || !root.isArray()) {
            throw invalid("The manifest must be a JSON array with one item per file");
        }
        if (root.size() != files) {
            throw invalid("The manifest has " + root.size() + " items for " + files + " files");
        }
        List<Item> items = new ArrayList<>(files);
        for (int i = 0; i < root.size(); i++) {
            items.add(item(root.get(i), i + 1));
        }
        return List.copyOf(items);
    }

    private static Item item(JsonNode node, int position) {
        if (node == null || !node.isObject()) {
            throw invalid("Manifest item " + position + " is not an object");
        }
        JsonNode sha = node.get("sha256");
        if (sha == null || !sha.isString() || !SHA256.matcher(sha.asString()).matches()) {
            throw invalid("Manifest item " + position + " has no valid sha256");
        }
        JsonNode selected = node.get("selected");
        if (selected == null || !selected.isBoolean()) {
            throw invalid("Manifest item " + position + " has no selected flag");
        }
        JsonNode state = node.get("state");
        String previewState = null;
        if (state != null && !state.isNull()) {
            if (!state.isString() || state.asString().length() > MAX_STATE_CHARS) {
                throw invalid("Manifest item " + position + " has an invalid state");
            }
            previewState = state.asString();
        }
        return new Item(sha.asString(), selected.asBoolean(), previewState);
    }

    private static ApiException invalid(String message) {
        return new ApiException(ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST, message);
    }
}
