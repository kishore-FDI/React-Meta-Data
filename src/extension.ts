// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as fs from 'fs';
import * as path from 'path';

interface MetaData {
	filePath: string;
	title: string;
	description: string; 
	textContent: string[];
}

interface ProjectMetaData {
	generatedAt: string;
	components: MetaData[];
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('React Meta Data extension is now active');

	let disposable = vscode.commands.registerCommand('react-meta-data.extractMetaData', async () => {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders) {
				vscode.window.showErrorMessage('Please open a workspace first');
				return;
			}

			// Show progress indicator
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Extracting React Component Metadata",
				cancellable: false
			}, async (progress) => {
				const rootPath = workspaceFolders[0].uri.fsPath;
				
				progress.report({ message: "Finding React components..." });
				const components = await findReactComponents(rootPath);

				if (components.length === 0) {
					vscode.window.showInformationMessage('No React components found in the workspace');
					return;
				}

				const metadata: ProjectMetaData = {
					generatedAt: new Date().toISOString(),
					components: []
				};

				for (let i = 0; i < components.length; i++) {
					const componentPath = components[i];
					progress.report({ 
						message: `Processing component ${i + 1}/${components.length}`,
						increment: (100 / components.length)
					});

					try {
						const content = fs.readFileSync(componentPath, 'utf-8');
						const componentMetadata = await extractMetaData(content, componentPath);
						metadata.components.push({
							...componentMetadata,
							filePath: path.relative(rootPath, componentPath)
						});
					} catch (error) {
						console.error(`Error processing ${componentPath}:`, error);
					}
				}

				// Save metadata to root directory
				const metadataPath = path.join(rootPath, 'project-metadata.json');
				fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
				
				// Generate and inject meta tags
				const indexHtmlPath = path.join(rootPath, 'public', 'index.html');
				if (fs.existsSync(indexHtmlPath)) {
					let htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');
					
					// Remove existing auto-generated meta tags
					htmlContent = htmlContent.replace(
						/<!-- Auto-generated meta tags -->[\s\S]*?<!-- End auto-generated meta tags -->/,
						''
					);

					// Insert new meta tags before </head>
					const metaTags = generateMetaTagsFile(metadata);
					htmlContent = htmlContent.replace(
						'</head>',
						`${metaTags}\n</head>`
					);

					// Write back to index.html
					fs.writeFileSync(indexHtmlPath, htmlContent);
					vscode.window.showInformationMessage('Meta tags updated in index.html');
				}
			});

		} catch (error) {
			console.error('Error:', error);
			vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	context.subscriptions.push(disposable);
}

async function findReactComponents(rootPath: string): Promise<string[]> {
	const components: string[] = [];
	
	async function searchDirectory(dirPath: string) {
		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			
			for (const entry of entries) {
				const fullPath = path.join(dirPath, entry.name);
				
				if (entry.isDirectory()) {
					// Skip node_modules and hidden directories
					if (entry.name !== 'node_modules' && 
						entry.name !== 'dist' && 
						entry.name !== 'build' && 
						!entry.name.startsWith('.')) {
						await searchDirectory(fullPath);
					}
				} else if (isReactComponent(fullPath)) {
					console.log('Found component:', fullPath); // Debug log
					components.push(fullPath);
				}
			}
		} catch (error) {
			console.error(`Error searching directory ${dirPath}:`, error);
		}
	}
	
	await searchDirectory(rootPath);
	console.log('Total components found:', components.length); // Debug log
	return components;
}

function isReactComponent(fileName: string): boolean {
	const supportedExtensions = ['.jsx', '.tsx', '.js', '.ts'];
	const ext = path.extname(fileName).toLowerCase();
	
	if (!supportedExtensions.includes(ext)) {
		return false;
	}
	
	try {
		const content = fs.readFileSync(fileName, 'utf-8');
		// Look for JSX/TSX syntax or React imports
		return (
			content.includes('<') && content.includes('/>') || // JSX self-closing tags
			content.includes('</') || // JSX closing tags
			content.includes('import React') ||
			content.includes('from "react"') ||
			content.includes("from 'react'")
		);
	} catch (error) {
		console.error(`Error reading file ${fileName}:`, error);
		return false;
	}
}

// Add this function to generate meta tags
function generateMetaTagsFile(metadata: ProjectMetaData): string {
	// Collect all unique text content
	const allContent = metadata.components
		.flatMap(comp => comp.textContent)
		.filter((value, index, self) => self.indexOf(value) === index); // Remove duplicates

	// Generate meta tags HTML
	const metaTags = `
<!-- Auto-generated meta tags -->
<meta name="description" content="${allContent.slice(0, 5).join(' | ')}" />
<meta name="keywords" content="${allContent.join(', ')}" />
<meta property="og:title" content="React Application" />
<meta property="og:description" content="${allContent.slice(0, 3).join(' | ')}" />
<meta name="twitter:title" content="React Application" />
<meta name="twitter:description" content="${allContent.slice(0, 3).join(' | ')}" />
<!-- End auto-generated meta tags -->
`;

	return metaTags;
}

// Modify the main command to also generate meta tags
async function extractMetaData(sourceCode: string, filePath: string = ''): Promise<MetaData> {
	const metadata: MetaData = {
		filePath: filePath,
		title: '',
		description: '',
		textContent: []
	};

	try {
		const ast = parse(sourceCode, {
			sourceType: 'module',
			plugins: ['jsx', 'typescript', 'decorators-legacy'],
		});

		// Track variables that might contain content
		const contentVariables: Map<string, string[]> = new Map();

		traverse(ast, {
			// Handle export declarations
			ExportNamedDeclaration(path) {
				if (path.node.declaration && 
					path.node.declaration.type === 'VariableDeclaration') {
					const declaration = path.node.declaration.declarations[0];
					if (declaration.init && declaration.init.type === 'ArrayExpression') {
						// Process array elements
						declaration.init.elements.forEach((element: any) => {
							if (element.type === 'ObjectExpression') {
								element.properties.forEach((prop: any) => {
									// Extract name, price, and features
									if (prop.key.name === 'name' || 
										prop.key.name === 'price' ||
										prop.key.name === 'title' ||
										prop.key.name === 'description') {
										if (prop.value.type === 'StringLiteral') {
											const text = prop.value.value.trim();
											if (shouldIncludeText(text)) {
												metadata.textContent.push(text);
											}
										}
									}
									// Extract array of features
									else if (prop.key.name === 'features' && 
											 prop.value.type === 'ArrayExpression') {
										prop.value.elements.forEach((feature: any) => {
											if (feature && feature.type === 'StringLiteral') {
												const text = feature.value.trim();
												if (shouldIncludeText(text)) {
													metadata.textContent.push(text);
												}
											}
										});
									}
								});
							}
						});
					}
				}
			},

			// Handle variable declarations (for non-exported variables)
			VariableDeclarator(path) {
				try {
					if (path.node.init) {
						if (path.node.init.type === 'ArrayExpression') {
							path.node.init.elements.forEach((element: any) => {
								if (element.type === 'ObjectExpression') {
									element.properties.forEach((prop: any) => {
										// Skip JSX/SVG content
										if (prop.key.name === 'icon') {
											return;
										}
										
										// Extract string values
										if (prop.value?.type === 'StringLiteral') {
											const text = prop.value.value.trim();
											if (shouldIncludeText(text)) {
												metadata.textContent.push(text);
											}
										}
										// Extract array values (like features)
										else if (prop.value?.type === 'ArrayExpression') {
											prop.value.elements.forEach((item: any) => {
												if (item?.type === 'StringLiteral') {
													const text = item.value.trim();
													if (shouldIncludeText(text)) {
														metadata.textContent.push(text);
													}
												}
											});
										}
									});
								}
							});
						}
					}
				} catch (error) {
					console.error('Error processing variable declaration:', error);
				}
			},

			// Handle JSX Text nodes
			JSXText(path) {
				const text = path.node.value.trim();
				if (shouldIncludeText(text)) {
					metadata.textContent.push(text);
				}
			},

			// Handle JSX attributes
			JSXAttribute(path) {
				const attrName = path.node.name.name as string;
				
				// Skip SVG-related attributes and elements
				if (isSVGElement(attrName) || isSVGAttribute(attrName)) {
					return;
				}

				const parentName = (path.parent as { name?: { name: string } }).name?.name?.toLowerCase() || '';
				
				if (path.node.value) {
					let texts: string[] = [];
					
					try {
						// Handle different types of attribute values
						if (path.node.value.type === 'StringLiteral') {
							texts.push(path.node.value.value.trim());
						} 
						else if (path.node.value.type === 'JSXExpressionContainer') {
							// Handle direct variable references
							if (path.node.value.expression.type === 'Identifier') {
								const varName = path.node.value.expression.name;
								const varContent = contentVariables.get(varName);
								if (varContent) {
									texts.push(...varContent);
								}
							}
							// Handle array/object member expressions
							else if (path.node.value.expression.type === 'MemberExpression') {
								const objName = (path.node.value.expression.object as any).name;
								const varContent = contentVariables.get(objName);
								if (varContent) {
									texts.push(...varContent);
								}
							}
							// Handle string literals in expressions
							else if (path.node.value.expression.type === 'StringLiteral') {
								texts.push(path.node.value.expression.value.trim());
							}
						}

						// Process all collected texts
						texts.forEach(text => {
							if (text && shouldIncludeText(text)) {
								metadata.textContent.push(text);
							}
						});
					} catch (error) {
						console.error('Error processing JSX attribute:', error);
					}
				}
			},

			// Add handler for function declarations/components
			FunctionDeclaration(path) {
				// Process variable declarations inside functions
				path.traverse({
					VariableDeclarator(varPath) {
						if (varPath.node.init) {
							// Handle array literals
							if (varPath.node.init.type === 'ArrayExpression') {
								varPath.node.init.elements.forEach((element: any) => {
									if (element?.type === 'StringLiteral') {
										const text = element.value.trim();
										if (shouldIncludeText(text)) {
											metadata.textContent.push(text);
										}
									}
								});
							}
						}
					}
				});
			},

			// Add handler for arrow function components
			VariableDeclarator(path) {
				if (path.node.init?.type === 'ArrowFunctionExpression' || 
					path.node.init?.type === 'FunctionExpression') {
					// Process variable declarations inside arrow functions
					path.traverse({
						VariableDeclarator(varPath) {
							if (varPath.node.init) {
								// Handle array literals
								if (varPath.node.init.type === 'ArrayExpression') {
									varPath.node.init.elements.forEach((element: any) => {
										if (element?.type === 'StringLiteral') {
											const text = element.value.trim();
											if (shouldIncludeText(text)) {
												metadata.textContent.push(text);
											}
										}
									});
								}
							}
						}
					});
				}
			}
		});

		// Remove duplicates and empty strings
		metadata.textContent = [...new Set(metadata.textContent)]
			.filter(text => shouldIncludeText(text));

		// If no title found, use the filename
		if (!metadata.title && filePath) {
			metadata.title = path.basename(filePath, path.extname(filePath));
		}

		// If no description found, use the first meaningful text content
		if (!metadata.description && metadata.textContent.length > 0) {
			metadata.description = metadata.textContent[0];
		}

		return metadata;
	} catch (error) {
		console.error('Error:', error);
		throw new Error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function shouldIncludeText(text: string): boolean {
	if (!text || text.length === 0) return false;

	// Exclude common patterns
	const excludePatterns = [
		// CSS classes and styles (including custom classes with hyphens)
		/^[a-zA-Z0-9]+-[a-zA-Z0-9-_]+$/,  // Matches patterns like 'left-j', 'hero-text', etc.
		/^[a-zA-Z0-9]+_[a-zA-Z0-9-_]+$/,  // Matches underscore patterns
		/^(flex|grid|text-|bg-|p-|m-|w-|h-|border|rounded|shadow|transition|transform|scale|rotate|translate|opacity|blur)/,
		/^(container|wrapper|section|row|col|box|card|btn|button|nav|header|footer|sidebar|main|content)/,
		/^(xs|sm|md|lg|xl|2xl|hover|focus|active|disabled|selected|loading|error|success|warning|info)/,
		/^(animate|motion|fade|slide|zoom|spin|pulse|bounce|shake|flip|rotate|scale)/,
		/^(left|right|top|bottom|center|middle|start|end)-[a-zA-Z0-9-_]+$/,  // Position-based classes
		/^[a-zA-Z]+-container$/,  // Container classes
		/^[a-zA-Z]+-wrapper$/,    // Wrapper classes
		/^[a-zA-Z]+-section$/,    // Section classes
		/^[a-zA-Z]+-content$/,    // Content classes
		/^[a-zA-Z]+-component$/,  // Component classes
		
		// CSS values and measurements
		/^\d+(\.\d+)?(px|rem|em|vh|vw|%|s|ms)$/,
		
		// SVG specific patterns
		/^M[\d\s,.-]+$/i,  // SVG path starting with M
		/^[MLHVCSQTAZ][\d\s,.-]*$/i,  // Any SVG path command
		/^(path|svg|circle|rect|line|polygon|polyline|ellipse|g|defs|use|clipPath|mask|pattern|filter)$/,
		/^(stroke|fill|points|d|cx|cy|r|x|y|x1|y1|x2|y2|width|height|viewBox|transform)$/,
		/^matrix\(.*\)$/,
		/^translate\(.*\)$/,
		/^scale\(.*\)$/,
		/^rotate\(.*\)$/,
		/^[0-9\s.,-]+$/,  // Numbers, spaces, dots, commas, and hyphens only
		
		// Variable references and technical patterns
		/^var\(--.*\)$/,
		/^(true|false|null|undefined|NaN)$/,
		
		// Common utility classes
		/^(absolute|relative|fixed|static|block|inline|none|hidden|visible|invisible)$/,
		
		// Technical attributes
		/^(id|class|className|style|type|name|value|data-.*|aria-.*|role|tabindex|placeholder)$/,

		// Common class naming patterns
		/^[a-zA-Z]+-[0-9]+$/,     // e.g., 'blur-1'
		/^[a-zA-Z]+-[a-z]$/,      // e.g., 'blur-f'
		/^[a-zA-Z]+-[a-z]-[0-9]+$/  // e.g., 'blur-f-1'
	];

	// Check if text matches any exclude pattern
	if (excludePatterns.some(pattern => pattern.test(text))) {
		return false;
	}

	// Additional checks for class-like patterns
	if (text.includes('-') && !text.includes(' ')) {
		// If it contains a hyphen but no spaces, it's likely a class name
		return false;
	}

	// Include text that has any Unicode letters (including Tamil, Hindi, etc.)
	// and is not just a simple class name pattern
	return /\p{L}/u.test(text) && text.length > 1;
}

// Helper functions to check SVG elements and attributes
function isSVGElement(name: string): boolean {
	const svgElements = [
		'svg', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline',
		'ellipse', 'g', 'defs', 'use', 'clipPath', 'mask', 'pattern',
		'filter', 'text', 'tspan'
	];
	return svgElements.includes(name);
}

function isSVGAttribute(name: string): boolean {
	const svgAttributes = [
		'd', 'points', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
		'width', 'height', 'viewBox', 'fill', 'stroke', 'transform',
		'clipPath', 'maskUnits', 'gradientUnits', 'patternUnits',
		'filterUnits', 'stopColor', 'strokeWidth'
	];
	return svgAttributes.includes(name);
}

function getElementText(element: any): string {
	if (element.children) {
		return element.children
			.map((child: any) => {
				if (child.type === 'JSXText') {
					return child.value.trim();
				}
				return '';
			})
			.filter(Boolean)
			.join(' ');
	}
	return '';
}

// This method is called when your extension is deactivated
export function deactivate() {}
