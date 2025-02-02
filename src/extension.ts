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

export function activate(context: vscode.ExtensionContext) {
	console.log('React Meta Data extension is now active');

	let disposable = vscode.commands.registerCommand('react-meta-data.extractMetaData', async () => {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders) {
				vscode.window.showErrorMessage('Please open a workspace first');
				return;
			}

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
							filePath: path.relative(rootPath, componentPath),
							...componentMetadata
						});
					} catch (error) {
						console.error(`Error processing ${componentPath}:`, error);
					}
				}

				const metadataPath = path.join(rootPath, 'project-metadata.json');
				fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
				
				const indexHtmlPath = path.join(rootPath, 'public', 'index.html');
				if (fs.existsSync(indexHtmlPath)) {
					let htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');
					
					htmlContent = htmlContent.replace(
						/<!-- Auto-generated meta tags -->[\s\S]*?<!-- End auto-generated meta tags -->/,
						''
					);

					const metaTags = generateMetaTagsFile(metadata);
					htmlContent = htmlContent.replace(
						'</head>',
						`${metaTags}\n</head>`
					);

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
					if (entry.name !== 'node_modules' && 
						entry.name !== 'dist' && 
						entry.name !== 'build' && 
						!entry.name.startsWith('.')) {
						await searchDirectory(fullPath);
					}
				} else if (isReactComponent(fullPath)) {
					console.log('Found component:', fullPath); 
					components.push(fullPath);
				}
			}
		} catch (error) {
			console.error(`Error searching directory ${dirPath}:`, error);
		}
	}
	
	await searchDirectory(rootPath);
	console.log('Total components found:', components.length);
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
		return (
			content.includes('<') && content.includes('/>') || 
			content.includes('</') || 
			content.includes('import React') ||
			content.includes('from "react"') ||
			content.includes("from 'react'")
		);
	} catch (error) {
		console.error(`Error reading file ${fileName}:`, error);
		return false;
	}
}

function generateMetaTagsFile(metadata: ProjectMetaData): string {
	const allContent = metadata.components
		.flatMap(comp => comp.textContent)
		.filter((value, index, self) => self.indexOf(value) === index); 
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

		const contentVariables: Map<string, string[]> = new Map();

		traverse(ast, {
			ExportNamedDeclaration(path) {
				if (path.node.declaration && 
					path.node.declaration.type === 'VariableDeclaration') {
					const declaration = path.node.declaration.declarations[0];
					if (declaration.init && declaration.init.type === 'ArrayExpression') {
						declaration.init.elements.forEach((element: any) => {
							if (element.type === 'ObjectExpression') {
								element.properties.forEach((prop: any) => {
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

			VariableDeclarator(path) {
				try {
					if (path.node.init) {
						if (path.node.init.type === 'ArrayExpression') {
							path.node.init.elements.forEach((element: any) => {
								if (element.type === 'ObjectExpression') {
									element.properties.forEach((prop: any) => {
										if (prop.key.name === 'icon') {
											return;
										}
										
										if (prop.value?.type === 'StringLiteral') {
											const text = prop.value.value.trim();
											if (shouldIncludeText(text)) {
												metadata.textContent.push(text);
											}
										}
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

			JSXText(path) {
				const text = path.node.value.trim();
				if (shouldIncludeText(text)) {
					metadata.textContent.push(text);
				}
			},

			JSXAttribute(path) {
				const attrName = path.node.name.name as string;
				
				if (isSVGElement(attrName) || isSVGAttribute(attrName)) {
					return;
				}

				const parentName = path.parent.name?.name?.toLowerCase() || '';
				
				if (path.node.value) {
					let texts: string[] = [];
					
					try {
						if (path.node.value.type === 'StringLiteral') {
							texts.push(path.node.value.value.trim());
						} 
						else if (path.node.value.type === 'JSXExpressionContainer') {
							if (path.node.value.expression.type === 'Identifier') {
								const varName = path.node.value.expression.name;
								const varContent = contentVariables.get(varName);
								if (varContent) {
									texts.push(...varContent);
								}
							}
							else if (path.node.value.expression.type === 'MemberExpression') {
								const objName = (path.node.value.expression.object as any).name;
								const varContent = contentVariables.get(objName);
								if (varContent) {
									texts.push(...varContent);
								}
							}
							else if (path.node.value.expression.type === 'StringLiteral') {
								texts.push(path.node.value.expression.value.trim());
							}
						}

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

			FunctionDeclaration(path) {
				path.traverse({
					VariableDeclarator(varPath) {
						if (varPath.node.init) {
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

			VariableDeclarator(path) {
				if (path.node.init?.type === 'ArrowFunctionExpression' || 
					path.node.init?.type === 'FunctionExpression') {
					path.traverse({
						VariableDeclarator(varPath) {
							if (varPath.node.init) {
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

		metadata.textContent = [...new Set(metadata.textContent)]
			.filter(text => shouldIncludeText(text));

		if (!metadata.title && filePath) {
			metadata.title = path.basename(filePath, path.extname(filePath));
		}

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

	const excludePatterns = [
		/^[a-zA-Z0-9]+-[a-zA-Z0-9-_]+$/,  
		/^[a-zA-Z0-9]+_[a-zA-Z0-9-_]+$/,  		
		/^(flex|grid|text-|bg-|p-|m-|w-|h-|border|rounded|shadow|transition|transform|scale|rotate|translate|opacity|blur)/,
		/^(container|wrapper|section|row|col|box|card|btn|button|nav|header|footer|sidebar|main|content)/,
		/^(xs|sm|md|lg|xl|2xl|hover|focus|active|disabled|selected|loading|error|success|warning|info)/,
		/^(animate|motion|fade|slide|zoom|spin|pulse|bounce|shake|flip|rotate|scale)/,
		/^(left|right|top|bottom|center|middle|start|end)-[a-zA-Z0-9-_]+$/,  
		/^[a-zA-Z]+-container$/,
		/^[a-zA-Z]+-wrapper$/,  
		/^[a-zA-Z]+-section$/,
		/^[a-zA-Z]+-content$/,
		/^[a-zA-Z]+-component$/,
		
		/^\d+(\.\d+)?(px|rem|em|vh|vw|%|s|ms)$/,
		
		/^M[\d\s,.-]+$/i,
		/^[MLHVCSQTAZ][\d\s,.-]*$/i,
		/^(path|svg|circle|rect|line|polygon|polyline|ellipse|g|defs|use|clipPath|mask|pattern|filter)$/,
		/^(stroke|fill|points|d|cx|cy|r|x|y|x1|y1|x2|y2|width|height|viewBox|transform)$/,
		/^matrix\(.*\)$/,
		/^translate\(.*\)$/,
		/^scale\(.*\)$/,
		/^rotate\(.*\)$/,
		/^[0-9\s.,-]+$/,  
		
		/^var\(--.*\)$/,
		/^(true|false|null|undefined|NaN)$/,
		
		/^(absolute|relative|fixed|static|block|inline|none|hidden|visible|invisible)$/,
		
		/^(id|class|className|style|type|name|value|data-.*|aria-.*|role|tabindex|placeholder)$/,

		/^[a-zA-Z]+-[a-z]$/,      
		/^[a-zA-Z]+-[0-9]+$/,     
		/^[a-zA-Z]+-[a-z]-[0-9]+$/  
	];

	if (excludePatterns.some(pattern => pattern.test(text))) {
		return false;
	}

	if (text.includes('-') && !text.includes(' ')) {
		return false;
	}

	
	return /\p{L}/u.test(text) && text.length > 1;
}

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

export function deactivate() {}
