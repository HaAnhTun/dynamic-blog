package com.blog.postimport.dto;

/**
 * What a preview says about the ZIP package of a file, never about its text. The images that the article uses are the ones an
 * apply stores; the unused ones are not stored (each is a note of the file).
 *
 * @param entries entries (files and folders) of the archive
 * @param assets images under {@code assets/}
 * @param assetBytes bytes of those images as uploaded
 * @param usedAssets images that the article names (as an image, a figure or a link)
 * @param unusedAssets images that nothing names
 * @param unsupportedItems entries that cannot be used: an image of another format and a file outside {@code assets/}; each is a problem
 */
public record PostPackageFacts(
        int entries, int assets, long assetBytes, int usedAssets, int unusedAssets, int unsupportedItems) {}
